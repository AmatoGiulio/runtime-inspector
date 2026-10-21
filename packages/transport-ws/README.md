# @runtime-inspector/transport-ws

Local WebSocket broker for the [Runtime Inspector Protocol](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/protocol.md). It routes validated messages between runtime clients, panels, and workspace clients while retaining schemas for reconnecting panels.

Most app developers should use [@runtime-inspector/cli](https://www.npmjs.com/package/@runtime-inspector/cli), which starts this broker and serves the web panel automatically.

## Install

~~~bash
npm install @runtime-inspector/transport-ws@alpha
~~~

## Embedded usage

~~~ts
import { startBroker } from "@runtime-inspector/transport-ws";

const broker = startBroker({
  host: "127.0.0.1",
  port: 4577,
  token: process.env.RI_TOKEN
});

// On shutdown:
await broker.close();
~~~

`startBroker` defaults to loopback (`127.0.0.1`) and port `4577` unless overridden. A configured token is checked for panel and workspace clients during handshake; runtime connections use the protocol handshake too.

Only expose the broker on a trusted development network. The protocol and broker do **not** provide a production remote-access security model.

## Links

[Repository](https://github.com/AmatoGiulio/runtime-inspector) · [Protocol stability](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/protocol-stability.md) · [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md)

**Status:** alpha, APIs may change. MIT license.
