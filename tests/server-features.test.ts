import { describe, expect, it } from "bun:test";
import { Channel } from "ws-asyncapi";
import { z } from "zod";
import { wsAsyncAPIAdapter } from "../src/index.ts";

// Transport-specific server feature: the oversized-frame guard. (Graceful drain
// is a Node-adapter API; the Elysia app is drained via Elysia/Bun lifecycle.)
const chat = new Channel("/room/:id", "room").serverMessage(
	"message",
	z.object({ text: z.string() }),
);

describe("adapter-elysia server features", () => {
	it("rejects an oversized frame with close 1009", async () => {
		const app = wsAsyncAPIAdapter([chat], { maxPayload: 100 });
		const port = await new Promise<number>((resolve) =>
			app.listen(0, (server) => resolve(server.port)),
		);
		try {
			const ws = new WebSocket(`ws://localhost:${port}/room/1`);
			await new Promise<void>((res, rej) => {
				ws.onopen = () => res();
				ws.onerror = () => rej(new Error("connect failed"));
			});
			const closed = new Promise<number>((res) => {
				ws.onclose = (e) => res(e.code);
			});
			ws.send("x".repeat(5_000));
			expect(await closed).toBe(1009);
		} finally {
			// After a server-initiated 1009 close the half-closed socket can
			// wedge app.stop(); guard teardown so it can't hang the test.
			await Promise.race([
				app.stop(true),
				new Promise((r) => setTimeout(r, 1000)),
			]);
		}
	});
});
