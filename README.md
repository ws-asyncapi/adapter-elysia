# adapter-elysia

Elysia adapter for WebSocket AsyncAPI integration.

## Installation

```bash
npm install @ws-asyncapi/adapter-elysia
```

## Usage

```typescript
import { wsAsyncAPIAdapter } from "@ws-asyncapi/adapter-elysia";
import { Elysia } from "elysia";
import { Channel, getAsyncApiUI, getAsyncApiDocument } from "ws-asyncapi";
import { Type } from "@sinclair/typebox";

const channel = new Channel("/test/:id", "test")
    .$typeChannels<`some:${number}`>()
    .serverMessage(
        "response",
        Type.Object({
            data: Type.Tuple([Type.String(), Type.Number()]),
        })
    )
    .clientMessage(
        "test",
        ({ ws, message }) => {
            console.log(ws, message);
            ws.send("response", { data: ["test", 1] });
        },
        Type.Object({
            name: Type.String(),
        })
    )
    .onOpen((ws) => {
        ws.subscribe("some:1");
    });

const channels = [channel];
const document = getAsyncApiDocument([channel], {});

const app = new Elysia()
    .use(wsAsyncAPIAdapter(channels))
    .get("/asyncapi", () => getAsyncApiUI(document, "response"))
    .get("/asyncapi.json", document)
    .listen(3000);

setInterval(() => {
    channel.publish("some:1", "response", { data: ["test", 1] });
}, 1000);

console.log("Server running at http://localhost:3000");
```

## API

### `wsAsyncAPIAdapter(channels: AnyChannel[])`

-   `channels`: Array of AsyncAPI channel definitions
-   Returns Elysia plugin that registers WebSocket endpoints

## License

MIT
