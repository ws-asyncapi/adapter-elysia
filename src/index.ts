import { Elysia } from "elysia";
import {
	type AnyChannel,
	type AnyFrame,
	type Backplane,
	type Codec,
	type ErrorCode,
	Frame,
	jsonCodec,
	LocalBackplane,
	RpcError,
	validate,
} from "ws-asyncapi";
import { publishEvent } from "./emit.ts";
import { WebSocketElysia } from "./websocket.ts";

export interface WsAsyncAPIAdapterOptions {
	/** wire codec (default: JSON). Must match the client codec. */
	codec?: Codec;
	/**
	 * Horizontal-scaling backplane (default: in-process {@link LocalBackplane}).
	 * Swap in a Redis backplane to fan out across nodes.
	 */
	backplane?: Backplane;
}

export function wsAsyncAPIAdapter(
	channels: AnyChannel[],
	options: WsAsyncAPIAdapterOptions = {},
) {
	const codec = options.codec ?? jsonCodec;
	const backplane = options.backplane ?? new LocalBackplane();

	const app = new Elysia({
		name: "ws-asyncapi-adapter",
	});

	app.onStart(({ server }) => {
		if (!server) return;

		// Deliver every backplane message (local or cross-node) to this node's
		// subscribers. Origin is already filtered by cross-node backplanes.
		backplane.onMessage((message) => {
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
		}
	});

	app.onStop(() => backplane.close());

	for (const channel of channels) {
		app.ws(channel.address, {
			// No body schema: we decode with the codec ourselves so binary
			// codecs (msgpack) work. Elysia still pre-parses string frames.
			// @ts-ignore query schema is dynamic
			query: channel["~"].query,
			// @ts-ignore headers schema is dynamic
			headers: channel["~"].headers,
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
				// run .derive/.resolve in order, merging into connection data
				// @ts-expect-error derived data bag
				let data = ws.data["asyncapi-data"] || {};
				for (const derive of channel["~"].derives) {
					const result = await derive({ request, data });
					if (result && typeof result === "object")
						data = Object.assign(data, result);
				}
				// @ts-expect-error persist for message handlers
				ws.data["asyncapi-data"] = data;

				await channel["~"].onOpen?.({
					ws: new WebSocketElysia<any, any>(ws, codec, backplane),
					request,
					data,
				});
			},
			close: async (ws) => {
				await channel["~"].onClose?.({
					ws: new WebSocketElysia<any, any>(ws, codec, backplane),
					request: {
						query: ws.data.query,
						headers: ws.data.headers,
						params: ws.data.params,
					},
					// @ts-expect-error
					data: ws.data["asyncapi-data"],
				});
				// Persist recoverable state (rooms) before dropping the socket,
				// so a quick reconnect can re-join + replay missed events.
				// @ts-expect-error session id attached on Hello
				const sid: string | undefined = ws.data["asyncapi-sid"];
				if (sid && backplane.saveSession) {
					const rooms = await backplane.rooms(ws.id);
					if (rooms.length > 0)
						void backplane.saveSession(sid, { rooms });
				}
				// drop this socket from all rooms it was tracked in
				void backplane.removeSocket(ws.id);
			},
			message: async (ws, raw) => {
				let frame: AnyFrame;
				if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
					// binary codec (e.g. msgpack)
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
				if (!Array.isArray(frame)) return;

				const wsi = new WebSocketElysia<any, any>(ws, codec, backplane);
				const request = {
					query: ws.data.query,
					headers: ws.data.headers,
					params: ws.data.params,
				};
				// @ts-expect-error derived data attached on open
				const data = ws.data["asyncapi-data"] ?? {};

				// run per-message middleware; merges returns into a per-message
				// context copy and throws to reject the message
				const applyMiddleware = async (
					type: string,
					message: unknown,
				) => {
					if (channel["~"].middlewares.length === 0) return data;
					const ctxData = { ...data };
					for (const mw of channel["~"].middlewares) {
						const result = await mw({
							ws: wsi,
							type,
							message,
							request,
							data: ctxData,
						});
						if (result && typeof result === "object")
							Object.assign(ctxData, result);
					}
					return ctxData;
				};

				switch (frame[0]) {
					case Frame.Ping: {
						wsi.sendFrame([Frame.Pong, frame[1]]);
						return;
					}
					case Frame.Pong:
						return;
					case Frame.Hello: {
						// Connection-state-recovery handshake. A returning client
						// sends its session id + last-seen offset; if the session
						// is still recoverable we re-join its rooms and replay the
						// events it missed, then resume live.
						const requestedSid = frame[1];
						const clientOffset = frame[2] ?? 0;
						const sid = requestedSid ?? crypto.randomUUID();
						let recovered: 0 | 1 = 0;

						if (requestedSid && backplane.loadSession) {
							const session = await backplane.loadSession(requestedSid);
							if (session) {
								// re-join the rooms this session held
								for (const room of session.rooms)
									wsi.subscribe(room as never);
								// replay missed events (already-encoded frames, in
								// global publish order) before live resumes
								if (backplane.replaySince) {
									const missed = await backplane.replaySince(
										clientOffset,
										session.rooms,
									);
									for (const m of missed) wsi.sendRaw(m.payload);
								}
								await backplane.dropSession?.(requestedSid);
								recovered = 1;
							}
						}

						// remember the session id so close() can persist it
						// @ts-expect-error attach session id to connection data
						ws.data["asyncapi-sid"] = sid;

						// On a clean (non-recovered) connect, hand the client the
						// current offset as its starting cursor so a later blip
						// replays only from here, not from the whole buffer.
						const serverOffset = backplane.assignOffset
							? await backplane.assignOffset()
							: 0;
						wsi.sendFrame([Frame.Welcome, sid, recovered, serverOffset]);
						return;
					}
					case Frame.Command: {
						const [, name, payload] = frame;
						const entry = channel["~"].client.get(name);
						if (!entry)
							return console.warn(`No handler found for ${name}`);

						let message = payload;
						if (entry.validation) {
							const result = await validate(
								entry.validation,
								payload,
							);
							if (!result.ok) {
								return console.warn(
									`Invalid payload for command "${name}"`,
									result.issues,
								);
							}
							// hand the parsed value (transforms/defaults applied)
							message = result.value;
						}

						try {
							const ctxData = await applyMiddleware(name, message);
							await entry.handler({
								ws: wsi,
								message,
								request,
								data: ctxData,
							});
						} catch (error) {
							if (channel["~"].onError)
								channel["~"].onError({
									ws: wsi,
									error,
									type: name,
									data,
								});
							else
								console.error(
									`Error in command "${name}":`,
									error,
								);
						}
						return;
					}
					case Frame.Request: {
						const [, name, corrId, payload] = frame;
						const entry = channel["~"].rpc.get(name);
						if (!entry) {
							wsi.sendFrame([
								Frame.Error,
								corrId,
								"NOT_FOUND",
								`No RPC handler for "${name}"`,
							]);
							return;
						}

						const inputResult = await validate(entry.input, payload);
						if (!inputResult.ok) {
							wsi.sendFrame([
								Frame.Error,
								corrId,
								"VALIDATION",
								`Invalid input for RPC "${name}"`,
								inputResult.issues.slice(0, 5),
							]);
							return;
						}
						const message = inputResult.value;

						try {
							const ctxData = await applyMiddleware(name, message);
							const reply = await entry.handler({
								ws: wsi,
								message,
								request,
								data: ctxData,
							});
							wsi.sendFrame([Frame.Reply, corrId, reply]);
						} catch (error) {
							const code: ErrorCode =
								error instanceof RpcError
									? error.code
									: "INTERNAL";
							const message =
								error instanceof Error
									? error.message
									: String(error);
							const errData =
								error instanceof RpcError
									? error.data
									: undefined;
							wsi.sendFrame([
								Frame.Error,
								corrId,
								code,
								message,
								errData,
							]);
						}
						return;
					}
					default:
						return;
				}
			},
		});
	}

	return app;
}
