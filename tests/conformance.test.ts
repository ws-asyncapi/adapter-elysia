import { describe, expect, it } from "bun:test";
import { createClient } from "@ws-asyncapi/client";
import { msgpackCodec } from "@ws-asyncapi/codec-msgpack";
import {
	type ConformanceDriver,
	runConformance,
} from "@ws-asyncapi/testing/conformance";
import { jsonCodec, LocalBackplane } from "ws-asyncapi";
import { wsAsyncAPIAdapter } from "../src/index.ts";

// The shared protocol conformance contract over a REAL Elysia/Bun ws server +
// the real client, across JSON and msgpack. This is the layer that regressed in
// 0.1.0 (per-message `conn` reconstruction from `ws.data`); the INVARIANT
// scenario plus presence/auth/recovery exercise exactly that path. See also the
// dedicated presence.test.ts.
const elysiaDriver: ConformanceDriver = {
	name: "elysia",
	capabilities: { crossNode: true, recovery: true },
	async setup(channels, { codec, backplane, plugins }) {
		const bp = backplane ?? new LocalBackplane();
		const app = wsAsyncAPIAdapter(channels, {
			codec,
			backplane: bp,
			plugins,
		});
		const port = await new Promise<number>((resolve) =>
			app.listen(0, (server) => resolve(server.port)),
		);
		const path = channels[0].address.replace(/:[^/]+/g, "1");
		return {
			connect: (opts) =>
				createClient<never>(
					`ws://localhost:${port}`,
					(opts?.path ?? path) as never,
					{
						codec,
						query: opts?.query as never,
						headers: opts?.headers as never,
					},
				),
			backplane: bp,
			// stop(true) force-closes sockets; plain stop() hangs the test.
			close: () => app.stop(true),
		};
	},
};

runConformance(
	elysiaDriver,
	{ describe, it, expect },
	{
		codecs: [
			["json", jsonCodec],
			["msgpack", msgpackCodec],
		],
		backplanes: [
			{
				name: "local",
				create: () => new LocalBackplane(),
				crossNode: false,
				recovery: true,
			},
		],
	},
);
