import { describe, expect, it } from "bun:test";
import { createClient } from "@ws-asyncapi/client";
import type { Elysia } from "elysia";
import { Channel, RpcError } from "ws-asyncapi";
import { z } from "zod";
import { wsAsyncAPIAdapter } from "../src/index.ts";

// End-to-end conformance over a real Elysia/Bun ws server + the real client.
// This is the layer the in-memory test harness can't reach: the adapter's
// per-message reconstruction of `conn` from `ws.data` (see presence.test.ts).
const chat = new Channel("/room/:id", "room")
	.derive(({ request }) => ({ room: `room:${request.params.id}` }))
	.onOpen(({ ws, data }) => {
		ws.subscribe(data.room);
	})
	.serverMessage("message", z.object({ text: z.string() }))
	.clientMessage(
		"say",
		async ({ ws, message, data }) => {
			ws.publish(data.room, "message", { text: message.text });
		},
		z.object({ text: z.string() }),
	)
	.rpc(
		"add",
		z.object({ a: z.number(), b: z.number() }),
		z.object({ sum: z.number() }),
		async ({ message }) => ({ sum: message.a + message.b }),
	)
	.rpc(
		"boom",
		z.object({}),
		z.object({ ok: z.boolean() }),
		async () => {
			throw new RpcError("FORBIDDEN", "nope");
		},
	)
	.presence(z.object({ name: z.string() }))
	.history("message", { keep: 50 });

function serve(app: Elysia): Promise<{ port: number; stop: () => Promise<void> }> {
	return new Promise((resolve) => {
		// stop(true) force-closes sockets; a plain stop() would hang the test.
		app.listen(0, (server) =>
			resolve({ port: server.port, stop: () => app.stop(true) }),
		);
	});
}

function nextEvent<T>(
	client: { onEvent: (n: "message", cb: (d: T) => void) => () => void },
): Promise<T> {
	return new Promise((resolve) => {
		const off = client.onEvent("message", (d) => {
			off();
			resolve(d);
		});
	});
}

describe("adapter-elysia conformance", () => {
	it("opens (Welcome handshake) and answers an RPC", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const c = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			await c.opened;
			expect(c.connected).toBe(true);
			expect(await c.request("add", { a: 2, b: 3 })).toEqual({ sum: 5 });
			c.close();
		} finally {
			await stop();
		}
	});

	it("surfaces a handler throw as a typed RpcError", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const c = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			await c.opened;
			await expect(c.request("boom", {})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			c.close();
		} finally {
			await stop();
		}
	});

	it("fans a command out to the room", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const a = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			const b = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			await Promise.all([a.opened, b.opened]);
			const onB = nextEvent<{ text: string }>(b);
			a.call("say", { text: "hi" });
			expect(await onB).toEqual({ text: "hi" });
			a.close();
			b.close();
		} finally {
			await stop();
		}
	});

	it("presence survives across messages (the 0.1.0 regression)", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const c = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			await c.opened;
			await c.presence.set({ name: "Alice" });
			expect(c.presence.self).not.toBeNull();
			c.close();
		} finally {
			await stop();
		}
	});

	it("returns retained history for a subscribed room", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const c = createClient<typeof chat>(`ws://localhost:${port}`, "/room/1");
			await c.opened;
			c.call("say", { text: "one" });
			await nextEvent(c);
			const entries = (await c.history("room:1")) as Array<{
				event: string;
				data: { text: string };
			}>;
			expect(entries.map((e) => e.data.text)).toContain("one");
			c.close();
		} finally {
			await stop();
		}
	});
});
