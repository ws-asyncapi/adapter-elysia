import { Elysia } from "elysia";
import {
	type AnyChannel,
	type AnyFrame,
	applyCommand,
	type Backplane,
	type Codec,
	closeConnection,
	COMMAND_TOPIC,
	type Connection,
	dispatchFrame,
	jsonCodec,
	LocalBackplane,
	type NodeCommand,
	openConnection,
	OutboundRpc,
	publishEvent,
	type ServerPlugin,
	StreamRegistry,
} from "ws-asyncapi";
import { WebSocketElysia } from "./websocket.ts";

export interface WsAsyncAPIAdapterOptions {
	/** wire codec (default: JSON). Must match the client codec. */
	codec?: Codec;
	/**
	 * Horizontal-scaling backplane (default: in-process {@link LocalBackplane}).
	 * Swap in a Redis backplane to fan out across nodes.
	 */
	backplane?: Backplane;
	/**
	 * Max inbound message size in bytes; larger frames are rejected with close
	 * 1009 before they are decoded (DoS / decode-bomb guard). Default: 1 MiB.
	 * Raise it if you send large in-band payloads.
	 */
	maxPayload?: number;
	/** server-level plugins (metrics, tracing, logging) tapping every channel */
	plugins?: ServerPlugin[];
}

export function wsAsyncAPIAdapter(
	channels: AnyChannel[],
	options: WsAsyncAPIAdapterOptions = {},
) {
	const codec = options.codec ?? jsonCodec;
	const backplane = options.backplane ?? new LocalBackplane();
	const maxPayload = options.maxPayload ?? 1_048_576; // 1 MiB

	/** Byte size of a raw inbound frame (string or binary), for the payload cap. */
	const frameSize = (raw: unknown): number => {
		if (typeof raw === "string") return Buffer.byteLength(raw);
		if (raw instanceof ArrayBuffer) return raw.byteLength;
		if (ArrayBuffer.isView(raw)) return raw.byteLength;
		return 0; // already-parsed array: Elysia decoded it, treat as in-budget
	};

	// local socket registry (for exclusion delivery + presence listing)
	// biome-ignore lint/suspicious/noExplicitAny: ElysiaWS is dynamic
	const registry = new Map<string, any>();
	const rawOf = (ws: { raw?: { send: (d: unknown) => void } }) =>
		ws.raw ?? (ws as { send: (d: unknown) => void });
	const channelsByName = new Map(channels.map((c) => [c.name, c]));

	const decodeCommand = (payload: string | Uint8Array): NodeCommand | null => {
		try {
			return JSON.parse(
				typeof payload === "string"
					? payload
					: new TextDecoder().decode(payload),
			) as NodeCommand;
		} catch {
			return null;
		}
	};

	const app = new Elysia({
		name: "ws-asyncapi-adapter",
	});

	app.onStart(({ server }) => {
		if (!server) return;

		// Deliver every backplane message (local or cross-node) to this node's
		// subscribers. Origin is already filtered by cross-node backplanes.
		backplane.onMessage((message) => {
			if (message.topic === COMMAND_TOPIC) {
				const cmd = decodeCommand(message.payload);
				if (cmd)
					applyCommand(
						channelsByName.get(cmd.channel),
						cmd,
						message.origin === backplane.nodeId,
					);
				return;
			}
			if (message.except && message.except.length > 0) {
				// per-socket delivery so we can skip the excepted ids (Elysia's
				// server.publish can't exclude)
				const skip = new Set(message.except);
				void backplane.roomMembers(message.topic).then((members) => {
					for (const id of members) {
						if (skip.has(id)) continue;
						const ws = registry.get(id);
						if (ws) rawOf(ws).send(message.payload);
					}
				});
				return;
			}
			// biome-ignore lint/suspicious/noExplicitAny: publish accepts string | BufferSource
			server.publish(message.topic, message.payload as any);
		});

		for (const channel of channels) {
			channel["~"].globalPublish = (
				topic: string,
				type: string,
				// biome-ignore lint/suspicious/noExplicitAny: <explanation>
				data: any,
			) => {
				void publishEvent(backplane, codec, topic, type, data);
			};
			channel["~"].fetchSockets = async (room) => {
				const ids = room
					? await backplane.roomMembers(room)
					: [...registry.keys()];
				return Promise.all(
					ids.map(async (id) => ({
						id,
						rooms: (await backplane.rooms(id)).filter(
							(r) => !r.startsWith("#sid:"),
						),
					})),
				);
			};
			channel["~"].sendCommand = (cmd) => {
				void backplane.publish(COMMAND_TOPIC, JSON.stringify(cmd));
			};
			channel["~"].publishFrame = (topic, frame, except) =>
				void backplane.publish(topic, codec.encode(frame), undefined, except);
			if (options.plugins) channel["~"].serverPlugins = options.plugins;
			if (channel["~"].history.size)
				backplane.configureHistory?.(
					Object.fromEntries(channel["~"].history),
				);
		}
	});

	app.onStop(() => backplane.close());

	for (const channel of channels) {
		app.ws(channel.address, {
			// No body schema: we decode with the codec ourselves so binary
			// codecs (msgpack) work. Elysia still pre-parses string frames.
			// Query/headers are not handed to Elysia for validation: their schemas
			// are Standard Schema (not TypeBox), and they're typed via the contract
			// + parsed into `request` (matching the node adapter, which also doesn't
			// validate connection params at runtime).
			beforeHandle: async (ws) => {
				const result = await channel["~"].beforeUpgrade?.({
					query: ws.query,
					headers: ws.headers,
					params: ws.params,
				});
				if (result) {
					if (result instanceof Response) return result;
					Object.assign(ws, {
						"asyncapi-data": Object.assign(
							// @ts-expect-error attach derived data for handlers
							ws["asyncapi-data"] || {},
							result,
						),
					});
				}
			},
			open: async (ws) => {
				const request = {
					query: ws.data.query,
					headers: ws.data.headers,
					params: ws.data.params,
				};
				registry.set(ws.id, ws);
				// one OutboundRpc + StreamRegistry per connection (persist across messages)
				const outbound = new OutboundRpc();
				const streams = new StreamRegistry();
				const conn: Connection = {
					ws: new WebSocketElysia<any, any>(ws, codec, backplane, outbound),
					request,
					// @ts-expect-error initial data from beforeUpgrade
					data: ws.data["asyncapi-data"] || {},
					outbound,
					streams,
				};
				await openConnection(channel, conn);
				// Stash ALL mutable connection state for the message/close handlers.
				// Unlike the node adapter (one long-lived `conn` per socket), Elysia's
				// `app.ws` handlers are shared and keyed on `ws`, so every field the
				// core mutates (sessionId, data, presenceRoom, isPresent, …) must be
				// carried through `ws.data`. We snapshot the whole `conn` minus the
				// per-call `ws` wrapper so future core fields are picked up
				// automatically — enumerating fields by hand is exactly what silently
				// dropped presenceRoom/isPresent and broke presence in 0.1.0.
				const { ws: _wsOpen, ...connState } = conn;
				// @ts-expect-error per-connection state bag
				ws.data["asyncapi-conn"] = connState;
			},
			close: async (ws) => {
				// @ts-expect-error per-connection state bag
				const state = ws.data["asyncapi-conn"];
				if (!state) return;
				await closeConnection(channel, backplane, {
					...state,
					ws: new WebSocketElysia<any, any>(
						ws,
						codec,
						backplane,
						state.outbound,
					),
				});
				registry.delete(ws.id);
			},
			message: async (ws, raw) => {
				// @ts-expect-error per-connection state bag
				const state = ws.data["asyncapi-conn"];
				if (!state) return;

				if (frameSize(raw) > maxPayload) {
					try {
						ws.close(1009, "message too large");
					} catch {}
					return;
				}

				let frame: AnyFrame;
				if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
					try {
						frame = codec.decode(raw);
					} catch {
						return;
					}
				} else if (typeof raw === "string") {
					try {
						frame = codec.decode(raw);
					} catch {
						return;
					}
				} else if (Array.isArray(raw)) {
					// Elysia already JSON-parsed a string frame
					frame = raw as AnyFrame;
				} else {
					return;
				}

				const conn: Connection = {
					...state,
					ws: new WebSocketElysia<any, any>(
						ws,
						codec,
						backplane,
						state.outbound,
					),
				};
				await dispatchFrame(channel, backplane, conn, frame);
				// Write back EVERY field the core mutated (sessionId, data,
				// presenceRoom, isPresent, …) except the per-call ws wrapper, so the
				// next message/close sees the up-to-date state. Generic on purpose:
				// a new mutable core field is carried with no adapter change.
				const { ws: _wsMsg, ...rest } = conn;
				Object.assign(state, rest);
			},
		});
	}

	return app;
}
