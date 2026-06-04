# @ws-asyncapi/adapter-elysia

Elysia adapter for **ws-asyncapi** — contract-first, end-to-end-typed WebSockets with acknowledgements (RPC), rooms, presence, middleware, pluggable codecs, and horizontal scaling.

## Installation

```bash
npm install @ws-asyncapi/adapter-elysia ws-asyncapi elysia @sinclair/typebox
# schemas can use any Standard Schema validator instead of (or alongside) TypeBox:
# npm install zod   ·   npm install valibot   ·   npm install arktype
```

## Usage

```typescript
import { Elysia } from "elysia";
import { z } from "zod";
import { Type } from "@sinclair/typebox";
import { Channel, getAsyncApiDocument, getAsyncApiUI, RpcError } from "ws-asyncapi";
import { wsAsyncAPIAdapter } from "@ws-asyncapi/adapter-elysia";

const chat = new Channel("/chat/:room", "chat")
  .$typeChannels<`room:${string}`>()
  // query/headers use TypeBox (Elysia's connection binding); message payloads
  // below use Zod — mix validators freely.
  .query(Type.Object({ token: Type.String() }))

  // connection-scoped context (auth, db, decoded user) — typed everywhere
  .resolve(async ({ request }) => ({
    user: await getUser(request.query.token),
  }))

  // per-message middleware (auth/rate-limit/logging); throw to reject
  .beforeMessage(({ data }) => {
    if (!data.user) throw new RpcError("UNAUTHORIZED", "sign in first");
  })

  // server -> client event (fire-and-forget)
  .serverMessage("message", z.object({ from: z.string(), text: z.string() }))

  // client -> server command (fire-and-forget)
  .clientMessage(
    "typing",
    ({ ws }) => ws.publish("room:1", "message", { from: "sys", text: "..." }),
    z.object({ on: z.boolean() }),
  )

  // client -> server request/response (acknowledged RPC) — typed input AND output
  .rpc(
    "history",
    z.object({ limit: z.number().int().max(100).default(20) }),
    z.object({ items: z.array(z.string()) }),
    async ({ message, data }) => {
      // message.limit is the PARSED value (Zod default/coercion applied)
      return { items: await loadHistory(message.limit) };
    },
    // optional: declare typed errors → discriminated typed errors on the client
    { TOO_MANY: z.object({ max: z.number() }) },
  )

  .onOpen(({ ws }) => ws.subscribe("room:1"));

const channels = [chat];
const document = getAsyncApiDocument(channels, {});

const app = new Elysia()
  .use(wsAsyncAPIAdapter(channels))
  .get("/asyncapi", () => getAsyncApiUI(document, "response"))
  .get("/asyncapi.json", () => document)
  .listen(3000);

// broadcast to a room from anywhere
setInterval(() => chat.publish("room:1", "message", { from: "clock", text: new Date().toISOString() }), 1000);
```

Generate a fully-typed client from the running server with `@ws-asyncapi/cli`, then:

```ts
import { websocketAsyncAPI } from "@ws-asyncapi/client";

const client = websocketAsyncAPI("ws://localhost:3000", "/chat/1", { query: { token } });
await client.opened;

client.onEvent("message", (m) => console.log(m.from, m.text)); // typed
client.call("typing", { on: true });                            // typed, fire-and-forget
const { items } = await client.request("history", { limit: 50 }); // typed Promise<output>
```

The client auto-reconnects with backoff, sends heartbeats, buffers messages while offline, and surfaces RPC failures as typed `RpcError` (`VALIDATION` / `NOT_FOUND` / `INTERNAL` / `TIMEOUT` / your own codes).

### Codegen-free client (`createClient`)

If your client shares a TypeScript project (or a monorepo) with the server, skip the CLI
entirely and infer the typed client straight from the channel's type:

```ts
import type { chat } from "./server"; // the Channel value's type
import { createClient } from "@ws-asyncapi/client";

const client = createClient<typeof chat>("ws://localhost:3000", "/chat/1");
await client.opened;

client.onEvent("message", (m) => console.log(m.from, m.text)); // typed, inferred
client.call("typing", { on: true });                            // typed, inferred
const { items } = await client.request("history", { limit: 50 }); // typed, inferred
```

Same runtime, same types — no generated file, no build step. Use the CLI generator instead
when the client lives in a separate repo or a non-TypeScript codebase.

### Typed errors (`safeRequest`)

Errors you declare in `.rpc(..., errors)` flow through the contract into the generated client. `safeRequest` returns a discriminated `{ data, error }` result — narrow on `error.code` to get that error's typed `data`:

```ts
const res = await client.safeRequest("history", { limit: 500 });
if (res.error) {
  if (res.error.code === "TOO_MANY") {
    res.error.data.max; // number — typed from the contract
  }
} else {
  res.data.items; // string[] — typed output
}
```

`request()` still throws (rejects with `RpcError`); `safeRequest()` is the non-throwing, fully-typed variant.

### Server→client RPC (bidirectional acks)

RPCs work in both directions. Declare a server→client RPC with `.serverRpc()`; the **server**
calls it on a connection and awaits the client's typed reply, and the **client** answers it:

```ts
// contract
new Channel("/chat/:room", "chat")
  .serverRpc("confirm", z.object({ action: z.string() }), z.object({ ok: z.boolean() }))
  .rpc("delete", z.object({ id: z.string() }), z.object({ done: z.boolean() }),
    async ({ ws, message }) => {
      // server asks the client and awaits — fully typed
      const { ok } = await ws.request("confirm", { action: `delete ${message.id}` });
      return { done: ok };
    });
```

```ts
// client answers (typed input/output, inferred or generated)
client.onRequest("confirm", ({ action }) => ({ ok: window.confirm(action) }));
```

`ws.request()` rejects with a typed `RpcError` if the client throws, times out (`{ timeout }`),
or disconnects. It's the mirror of the client's `request()`.

### Streaming (`.stream`)

Beyond one-shot RPCs, a channel can declare a **stream**: the handler is an async
generator, and the client consumes a typed sequence with `for await`. Stopping the
loop cancels the stream server-side (the handler's `signal` aborts and its
`try/finally` runs):

```ts
// contract
.stream("prices", z.object({ symbol: z.string() }), z.object({ px: z.number() }),
  async function* ({ message, signal }) {
    const sub = market.subscribe(message.symbol);
    try {
      for await (const tick of sub) {
        if (signal.aborted) break;
        yield { px: tick.price };
      }
    } finally {
      sub.close(); // runs on client cancel / disconnect
    }
  })
```

```ts
// client — typed, inferred (or generated)
for await (const { px } of client.stream("prices", { symbol: "ACME" })) {
  render(px);
  if (done) break; // cancels the stream server-side
}
```

A server-side throw surfaces as a typed `RpcError` thrown into the `for await`.
Streams don't survive a reconnect (the server cancels them on disconnect), so
re-open after `onRecover`.

### Broadcasting & addressing

Beyond room `publish`, the server can address individual sockets and exclude the sender —
cluster-wide:

```ts
// inside a handler: broadcast to a room but NOT back to the sender
.clientMessage("msg", ({ ws, message }) =>
  ws.broadcast("room:1", "message", message), MsgSchema)

// from anywhere: send to one socket by id (Socket.IO's io.to(socketId).emit)
chat.toSocket(socketId, "message", { from: "system", text: "hi" });

// presence: list sockets in a room, cluster-wide
const sockets = await chat.fetchSockets("room:1"); // [{ id, rooms }, …]
```

`ws.id` (in handlers) is the socket's id; `client.request("...")` style RPCs are a common way
to hand a client its own id.

### Server management & cross-node messaging

These operate on sockets cluster-wide (every node applies them to its local sockets via the
backplane) — no node enumerates remote sockets:

```ts
chat.disconnectSockets("room:1");      // kick everyone in a room (or all, with no arg)
chat.socketsJoin("room:vip", "room:1"); // sockets in room:1 also join room:vip
chat.socketsLeave("room:vip");          // all sockets leave room:vip

// server↔server (not to clients): coordinate across nodes
chat.onServerEvent("cache:flush", (key) => localCache.delete(key));
chat.serverSideEmit("cache:flush", "user:42"); // runs on every OTHER node
```

> Note: with Bun/Elysia, `server.stop()` can hang after a socket was closed server-side
> (`disconnectSockets`) — a Bun quirk; the server itself keeps working.

### Connection-state-recovery

If the active backplane supports it (the default `LocalBackplane`, or `RedisBackplane` with `recovery` enabled), a client that briefly drops will, on reconnect, **re-join its rooms and replay the events it missed** — no gap, no manual refetch. The client tracks its offset automatically; you only react to whether recovery succeeded:

```ts
client.onRecover((recovered) => {
  if (!recovered) refetchEverything(); // clean (re)subscribe — server forgot the session
});
```

Recovery is automatic and on by default for `LocalBackplane`. Direct `ws.send(...)` to a single socket is not replayed (only room broadcasts are); the recovery window (`sessionTTL`, default 2 min) and replay log size (`bufferSize`, default 10k events) are tunable on the backplane.

## Schema libraries (Standard Schema)

Message payloads can use **any [Standard Schema](https://standardschema.dev) validator** —
**Zod, Valibot, ArkType** — or **TypeBox**, mixed freely within a channel. Validation, the
AsyncAPI contract, and the generated typed client work the same regardless. Handlers receive
the **parsed** value, so transforms / coercion / `.default()` are applied before your code
runs, and the doc is emitted as JSON Schema (draft-07) so descriptions, formats, enums, and
unions flow into the contract and the generated client types.

- **Zod (≥4.2)** and **ArkType (≥2.1.28)** work out of the box (they implement JSON Schema
  conversion natively).
- **Valibot** validates out of the box, but emits JSON Schema from a separate package —
  register it once at startup so the contract/codegen work:

  ```ts
  import { toJsonSchema } from "@valibot/to-json-schema";
  import { registerJsonSchemaConverter } from "ws-asyncapi";

  registerJsonSchemaConverter("valibot", (schema) => toJsonSchema(schema as never));
  ```

- **TypeBox** is always supported, and is what Elysia uses for `query` / `headers` binding.

## Options

```ts
wsAsyncAPIAdapter(channels, {
  codec,       // wire codec (default: JSON). Must match the client codec.
  backplane,   // scaling backplane (default: in-process LocalBackplane)
  maxPayload,  // max inbound message bytes (default: 1 MiB). Oversized frames
               // are rejected with close 1009 before decoding (DoS guard).
})
```

### Reliability & versioning

**Idempotent RPCs.** Delivery is at-least-once: a reply can be lost if the socket
drops after the handler ran, and a retry would run the handler twice. Tag a call
with a stable `idempotencyKey` and the server runs the handler once per key,
replaying the cached result to duplicates (retransmits, retries after reconnect,
or concurrent dupes) — so "charge once" stays once:

```ts
await client.request("charge", { amount: 50 }, { idempotencyKey: orderId });
```

**Contract version negotiation.** The client can send a `contractVersion`; if it
doesn't match the server's contract, the server rejects the connection up front
(`opened` rejects with a clear reason and the client stops reconnecting) instead
of silently mis-parsing frames after a deploy:

```ts
import { contractHash } from "ws-asyncapi";
createClient<typeof chat>(url, "/chat/1", { contractVersion: contractHash(chat) });
```

The contract hash is also emitted per channel in the AsyncAPI doc
(`x-ws-asyncapi-contract-hash`). `client.opened` resolves once the handshake
completes (so a version mismatch is observable there).

### Pluggable codec (binary)

```ts
import { msgpackCodec } from "@ws-asyncapi/codec-msgpack";
wsAsyncAPIAdapter(channels, { codec: msgpackCodec });
// client: websocketAsyncAPI(url, path, { codec: msgpackCodec })
```

### Horizontal scaling (Redis)

Run many nodes behind a load balancer; `publish`, rooms, and presence work across the whole cluster.

```ts
import { RedisBackplane } from "@ws-asyncapi/backplane-redis";
wsAsyncAPIAdapter(channels, {
  backplane: new RedisBackplane({
    url: "redis://localhost:6379",
    // opt in to cluster-wide connection-state-recovery (replay log + sessions)
    recovery: { sessionTTL: 120_000, bufferSize: 10_000 },
  }),
});
```

Presence / fetch-sockets, cluster-wide:

```ts
.rpc("online", Type.Object({}), Type.Object({ count: Type.Number() }),
  async ({ ws }) => ({ count: (await ws.roomMembers("room:1")).length }))
```

## API

- `wsAsyncAPIAdapter(channels, options?)` — Elysia plugin that registers a WS route per channel.
- Channel builder: `query` · `headers` · `serverMessage` (events) · `clientMessage` (commands) · `rpc` (client→server acks, optional typed `errors`) · `serverRpc` (server→client acks) · `derive` / `resolve` (typed context) · `beforeMessage` (middleware) · `onError` · `onOpen` / `onClose` · `beforeUpgrade` · `publish` · `toSocket` (target one socket) · `fetchSockets` (presence) · `disconnectSockets` / `socketsJoin` / `socketsLeave` (cluster-wide) · `serverSideEmit` / `onServerEvent` (server↔server) · `$typeChannels`.
- In handlers, `ws`: `send` · `publish` · `broadcast` (exclude sender) · `request` (server→client RPC) · `subscribe` / `unsubscribe` / `isSubscribed` · `roomMembers` (presence) · `id` · `close`.
- On the client: `request` (throws) · `safeRequest` (typed `{ data, error }`) · `call` (fire-and-forget) · `onEvent` · `onRequest` (answer server→client RPC) · `onOpen` / `onClose` / `onError` · `onRecover` · `sessionId` · `recovered` · `close`.

## License

MIT
