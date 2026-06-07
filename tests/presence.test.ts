import { describe, expect, it } from "bun:test";
import type { Elysia } from "elysia";
import { Channel, Frame } from "ws-asyncapi";
import { z } from "zod";
import { wsAsyncAPIAdapter } from "../src/index.ts";

/** Start an adapter app on an ephemeral port and resolve once it's listening. */
function serve(app: Elysia): Promise<{ port: number; stop: () => Promise<void> }> {
	return new Promise((resolve) => {
		app.listen(0, (server) => {
			// stop(true) force-closes active connections; a plain stop() waits for
			// sockets to drain and would hang the test.
			resolve({ port: server.port, stop: () => app.stop(true) });
		});
	});
}

// Regression for the 0.1.0 bug: the Elysia adapter rebuilt the per-connection
// `conn` from a hand-listed `ws.data` bag on every message and forgot
// `presenceRoom`/`isPresent`. The core sets `conn.presenceRoom` in
// `openConnection`, but because it was dropped between handlers, every presence
// op saw `!conn.presenceRoom` and replied NOT_FOUND "presence is not enabled".
// The node adapter keeps one live `conn` per socket, so it was unaffected — and
// there was no adapter-level e2e test, so it shipped to npm.
const chat = new Channel("/room/:id", "room").presence(
	z.object({ name: z.string() }),
);

type WireFrame = [number, ...unknown[]];

/** Open a ws, drive one frame, and collect frames until `done(frame)` is true. */
async function exchange(
	url: string,
	send: WireFrame,
	done: (f: WireFrame) => boolean,
	timeoutMs = 2000,
): Promise<WireFrame> {
	const ws = new WebSocket(url);
	try {
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("ws connect timed out")), timeoutMs);
			ws.onopen = () => {
				clearTimeout(t);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(t);
				reject(new Error("ws connect failed"));
			};
		});
		const got = new Promise<WireFrame>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for reply")),
				timeoutMs,
			);
			ws.onmessage = (e) => {
				const frame = JSON.parse(String(e.data)) as WireFrame;
				if (done(frame)) {
					clearTimeout(timer);
					resolve(frame);
				}
			};
		});
		ws.send(JSON.stringify(send));
		return await got;
	} finally {
		ws.close();
	}
}

describe("adapter-elysia presence", () => {
	it("answers PresenceSet with a roster reply, not NOT_FOUND", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const frame = await exchange(
				`ws://localhost:${port}/room/1`,
				[Frame.PresenceSet, 1, { name: "Alice" }],
				// resolve on the corrId=1 answer, whether Reply or Error
				(f) =>
					(f[0] === Frame.Reply || f[0] === Frame.Error) && f[1] === 1,
			);

			// Before the fix this was [Frame.Error, 1, "NOT_FOUND", ...].
			expect(frame[0]).toBe(Frame.Reply);
			const snapshot = frame[2] as {
				self: string;
				members: Record<string, { name: string }>;
			};
			expect(snapshot.members[snapshot.self]).toEqual({ name: "Alice" });
		} finally {
			await stop();
		}
	});

	it("answers PresenceQuery with a roster reply", async () => {
		const { port, stop } = await serve(wsAsyncAPIAdapter([chat]));
		try {
			const frame = await exchange(
				`ws://localhost:${port}/room/1`,
				[Frame.PresenceQuery, 7],
				(f) =>
					(f[0] === Frame.Reply || f[0] === Frame.Error) && f[1] === 7,
			);
			expect(frame[0]).toBe(Frame.Reply);
		} finally {
			await stop();
		}
	});
});
