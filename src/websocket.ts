import type { ElysiaWS } from "elysia/ws";
import {
	type AnyFrame,
	type Backplane,
	type Codec,
	Frame,
	jsonCodec,
	type WebSocketImplementation,
	type WebsocketDataType,
} from "ws-asyncapi";

export class WebSocketElysia<WebsocketData extends WebsocketDataType, Topics>
	implements WebSocketImplementation<WebsocketData, Topics>
{
	constructor(
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		private ws: ElysiaWS<any, any>,
		private codec: Codec = jsonCodec,
		private backplane?: Backplane,
	) {}

	get id(): string {
		return this.ws.id;
	}

	/** Low-level: encode and send any wire frame. */
	sendFrame(frame: AnyFrame): void {
		const data = this.codec.encode(frame);
		// Use the raw Bun socket: Elysia's `send` JSON-serializes non-string
		// payloads, which corrupts binary codecs (msgpack). Bun's raw `send`
		// sends strings as text and Uint8Array as a binary frame.
		const raw = this.ws.raw ?? this.ws;
		// biome-ignore lint/suspicious/noExplicitAny: send accepts string | BufferSource
		raw.send(data as any);
	}

	send<T extends keyof WebsocketData["server"]>(
		type: T,
		...data: WebsocketData["server"][T] extends never
			? []
			: [WebsocketData["server"][T]]
	): void {
		this.sendFrame([Frame.Event, type as string, data[0]]);
	}

	subscribe(topic: Topics): void {
		if (typeof topic === "string") {
			this.ws.subscribe(topic);
			// membership is eventually consistent; don't block the caller
			void this.backplane?.addToRoom(topic, this.id);
		}
	}

	unsubscribe(topic: Topics): void {
		if (typeof topic === "string") {
			this.ws.unsubscribe(topic);
			void this.backplane?.removeFromRoom(topic, this.id);
		}
	}

	isSubscribed(topic: Topics): boolean {
		if (typeof topic === "string") return this.ws.isSubscribed(topic);
		return false;
	}

	publish<T extends keyof WebsocketData["server"]>(
		topic: Topics,
		type: T,
		...data: WebsocketData["server"][T] extends never
			? []
			: [WebsocketData["server"][T]]
	): void {
		if (typeof topic !== "string") return;
		const payload = this.codec.encode([Frame.Event, type as string, data[0]]);

		if (this.backplane) {
			// fan out across the cluster; the backplane delivers locally too
			void this.backplane.publish(topic, payload);
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: publish accepts string | BufferSource
			this.ws.publish(topic, payload as any);
		}
	}

	async roomMembers(topic: Topics): Promise<string[]> {
		if (typeof topic === "string" && this.backplane)
			return this.backplane.roomMembers(topic);
		return [];
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason);
	}
}
