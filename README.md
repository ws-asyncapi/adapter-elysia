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
import { Type } from "@sinclair/typebox";
import { Channel, getAsyncApiDocument, getAsyncApiUI } from "ws-asyncapi";
import { wsAsyncAPIAdapter } from "@ws-asyncapi/adapter-elysia";

const chat = new Channel("/chat/:room", "chat")
  .$typeChannels<`room:${string}`>()
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
  .serverMessage("message", Type.Object({ from: Type.String(), text: Type.String() }))

  // client -> server command (fire-and-forget)
  .clientMessage(
    "typing",
    ({ ws }) => ws.publish("room:1", "message", { from: "sys", text: "..." }),
    Type.Object({ on: Type.Boolean() }),
  )

  // client -> server request/response (acknowledged RPC) — typed input AND output
  .rpc(
    "history",
    Type.Object({ limit: Type.Number() }),
    Type.Object({ items: Type.Array(Type.String()) }),
    async ({ message, data }) => {
      if (message.limit > 100)
        throw new RpcError("TOO_MANY", "limit too high", { max: 100 });
      return { items: await loadHistory(message.limit) };
    },
    // optional: declare typed errors → discriminated typed errors on the client
    { TOO_MANY: Type.Object({ max: Type.Number() }) },
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

### Connection-state-recovery

If the active backplane supports it (the default `LocalBackplane`, or `RedisBackplane` with `recovery` enabled), a client that briefly drops will, on reconnect, **re-join its rooms and replay the events it missed** — no gap, no manual refetch. The client tracks its offset automatically; you only react to whether recovery succeeded:

```ts
client.onRecover((recovered) => {
  if (!recovered) refetchEverything(); // clean (re)subscribe — server forgot the session
});
```

Recovery is automatic and on by default for `LocalBackplane`. Direct `ws.send(...)` to a single socket is not replayed (only room broadcasts are); the recovery window (`sessionTTL`, default 2 min) and replay log size (`bufferSize`, default 10k events) are tunable on the backplane.

## Schema libraries (Standard Schema)

Schemas can be defined with **any [Standard Schema](https://standardschema.dev) validator**
— Zod, Valibot, ArkType — or with TypeBox. Mix freely; the contract, validation, and the
generated typed client work the same regardless.

```ts
import { z } from "zod";

new Channel("/chat/:room", "chat")
  .rpc(
    "history",
    z.object({ limit: z.number().int().max(100).default(20) }),
    z.object({ items: z.array(z.string()) }),
    async ({ message }) => ({ items: await loadHistory(message.limit) }),
    { TOO_MANY: z.object({ max: z.number() }) },
  );
```

Handlers receive the **parsed** value, so transforms / coercion / `.default()` are applied
before your code runs. The AsyncAPI doc is generated as JSON Schema (draft-07) via the
validator's `StandardJSONSchemaV1` converter — so descriptions, formats, enums, and unions
all flow into the contract and the generated client types. TypeBox is still supported and is
what Elysia uses for `query` / `headers` binding.

## Options

```ts
wsAsyncAPIAdapter(channels, {
  codec,      // wire codec (default: JSON). Must match the client codec.
  backplane,  // scaling backplane (default: in-process LocalBackplane)
})
```

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
- Channel builder: `query` · `headers` · `serverMessage` (events) · `clientMessage` (commands) · `rpc` (acks, optional typed `errors`) · `derive` / `resolve` (typed context) · `beforeMessage` (middleware) · `onError` · `onOpen` / `onClose` · `beforeUpgrade` · `publish` · `$typeChannels`.
- In handlers, `ws`: `send` · `publish` · `subscribe` / `unsubscribe` / `isSubscribed` · `roomMembers` (presence) · `close`.
- On the client: `request` (throws) · `safeRequest` (typed `{ data, error }`) · `call` (fire-and-forget) · `onEvent` · `onOpen` / `onClose` / `onError` · `onRecover` · `sessionId` · `recovered` · `close`.

## License

MIT
