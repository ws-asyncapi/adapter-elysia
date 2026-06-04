# @ws-asyncapi/adapter-elysia

Elysia adapter for **ws-asyncapi** — contract-first, end-to-end-typed WebSockets with acknowledgements (RPC), rooms, presence, middleware, pluggable codecs, and horizontal scaling.

## Installation

```bash
npm install @ws-asyncapi/adapter-elysia ws-asyncapi elysia @sinclair/typebox
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
    async ({ message, data }) => ({ items: await loadHistory(message.limit) }),
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
  backplane: new RedisBackplane({ url: "redis://localhost:6379" }),
});
```

Presence / fetch-sockets, cluster-wide:

```ts
.rpc("online", Type.Object({}), Type.Object({ count: Type.Number() }),
  async ({ ws }) => ({ count: (await ws.roomMembers("room:1")).length }))
```

## API

- `wsAsyncAPIAdapter(channels, options?)` — Elysia plugin that registers a WS route per channel.
- Channel builder: `query` · `headers` · `serverMessage` (events) · `clientMessage` (commands) · `rpc` (acks) · `derive` / `resolve` (typed context) · `beforeMessage` (middleware) · `onError` · `onOpen` / `onClose` · `beforeUpgrade` · `publish` · `$typeChannels`.
- In handlers, `ws`: `send` · `publish` · `subscribe` / `unsubscribe` / `isSubscribed` · `roomMembers` (presence) · `close`.

## License

MIT
