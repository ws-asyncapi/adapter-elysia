import { Elysia, t } from "elysia";
import type { AnyChannel } from "ws-asyncapi";
import { WebSocketElysia } from "./websocket.ts";

// TODO: fix this code... so many ts-ignores

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
					// biome-ignore lint/suspicious/noExplicitAny: <explanation>
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
			// @ts-ignore
			query: channel["~"].query,
			// @ts-ignore
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
						// TODO: fix this code...
						// @ts-expect-error
						"asyncapi-data": Object.assign(ws["asyncapi-data"] || {}, result),
					});
				}
			},
			open: (ws) =>
				channel["~"].onOpen?.({
					ws: new WebSocketElysia(ws),
					request: {
						query: ws.data.query,
						headers: ws.data.headers,
						params: ws.data.params,
					},
					// @ts-expect-error
					data: ws.data["asyncapi-data"],
				}),
			close: (ws) =>
				channel["~"].onClose?.({
					ws: new WebSocketElysia(ws),
					request: {
						query: ws.data.query,
						headers: ws.data.headers,
						params: ws.data.params,
					},
					// @ts-expect-error
					data: ws.data["asyncapi-data"],
				}),
			message: async (ws, message) => {
				// @ts-ignore https://github.com/ws-asyncapi/adapter-elysia/actions/runs/13753755789/job/38457996320 works fine on ci but fails locally
				const [type, data] = message;

				const result = channel["~"].client.get(type);
				if (!result) return console.warn(`No handler found for ${type}`);

				await result.handler({
					ws: new WebSocketElysia(ws),
					message: data,
					request: {
						query: ws.data.query,
						headers: ws.data.headers,
						params: ws.data.params,
					},
					// @ts-expect-error
					data: ws.data["asyncapi-data"],
				});
			},
		});
	}

	return app;
}
