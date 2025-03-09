import { Elysia, t } from "elysia";
import type { AnyChannel } from "ws-asyncapi";
import { WebSocketElysia } from "./websocket.ts";

export function wsAsyncAPIAdapter(channels: AnyChannel[]) {
	const app = new Elysia({
		name: "ws-asyncapi-adapter",
	});

	app.onStart(({ server }) => {
		if (server) {
			for (const channel of channels) {
				channel["~"].globalPublish = (
					topic: string,
					type: string,
					data: any,
				) => {
					server.publish(topic, JSON.stringify([type, data]));
				};
			}
		}
	});

	for (const channel of channels) {
		app.ws(channel.address, {
			body: t.Tuple([t.String(), t.Any()]),
			open: (ws) => channel["~"].onOpen?.(new WebSocketElysia(ws)),
			message: async (ws, message) => {
				const [type, data] = message;

				const result = channel["~"].client.get(type);
				if (!result) return console.warn(`No handler found for ${type}`);

				await result.handler({
					ws: new WebSocketElysia(ws),
					message: data,
				});
			},
		});
	}

	return app;
}
