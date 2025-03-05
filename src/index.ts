import { Elysia, t } from "elysia";
import type { AnyChannel } from "ws-asyncapi";

export function wsAsyncAPIAdapter(channels: AnyChannel[]) {
    const app = new Elysia({
        name: "ws-asyncapi-adapter",
    });

    for (const channel of channels) {
        app.ws(channel.address, {
            body: t.Tuple([t.String(), t.Any()]),
            message: async (ws, message) => {
                const [type, data] = message;

                const result = channel["~"].client.get(type);
                if (!result) return console.warn(`No handler found for ${type}`);

                await result.handler({ ws, message: data });
            },
        });
    }

    return app;
}