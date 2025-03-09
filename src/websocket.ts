import type { ElysiaWS } from "elysia/ws";
import type { WebSocketImplementation, WebsocketDataType } from "ws-asyncapi";

export class WebSocketElysia<WebsocketData extends WebsocketDataType>
	implements WebSocketImplementation<WebsocketData>
{
	// biome-ignore lint/suspicious/noExplicitAny: <explanation>
	constructor(private ws: ElysiaWS<any, any>) {}

	send<T extends keyof WebsocketData["server"]>(
		type: T,
		data: WebsocketData["server"][T],
	): void {
		this.ws.sendText(JSON.stringify([type, data]));
	}
}
