import type { ElysiaWS } from "elysia/ws";
import type { WebSocketImplementation, WebsocketDataType } from "ws-asyncapi";

export class WebSocketElysia<WebsocketData extends WebsocketDataType, Topics>
	implements WebSocketImplementation<WebsocketData, Topics>
{
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	constructor(private ws: ElysiaWS<any, any>) {}

	send<T extends keyof WebsocketData["server"]>(
		type: T,
		...data: WebsocketData["server"][T] extends never
			? []
			: [WebsocketData["server"][T]]
	): void {
		this.ws.sendText(JSON.stringify([type, ...data]));
	}

	subscribe(topic: Topics): void {
		// temporal hack
		if (typeof topic === "string") this.ws.subscribe(topic);
	}

	unsubscribe(topic: Topics): void {
		// temporal hack
		if (typeof topic === "string") this.ws.unsubscribe(topic);
	}

	isSubscribed(topic: Topics): boolean {
		// temporal hack
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
		if (typeof topic === "string")
			this.ws.publish(topic, JSON.stringify([type, ...data]));
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason);
	}
}
