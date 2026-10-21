# @runtime-inspector/protocol

Shared TypeScript types and Zod schemas for the **Runtime Inspector Protocol (RIP)**. It defines the messages exchanged by the running app, panels, broker, and workspace client.

This is a low-level building block. To inspect an Expo / React Native app, start with [@runtime-inspector/react-native](https://www.npmjs.com/package/@runtime-inspector/react-native) instead.

## Install

~~~bash
npm install @runtime-inspector/protocol@alpha
~~~

## Usage

~~~ts
import {
  RIP_VERSION,
  safeParseRIPMessage,
  type PanelSchema,
  type RIPMessage
} from "@runtime-inspector/protocol";

console.log(RIP_VERSION);

const result = safeParseRIPMessage(JSON.parse(incomingJson));
if (result.success) {
  const message: RIPMessage = result.data;
  // Handle the validated message.
}
~~~

RIP covers handshakes, schema publication and disposal, value patches and commits, actions, runtime status, scenes, recording, and source write-back messages. Control kinds include sliders, toggles, colors, springs, Bézier curves, and triggers.

**Compatibility:** the broker checks `RIP_VERSION` at handshake. Unknown optional fields and additive message types are covered by the [protocol stability policy](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/protocol-stability.md). See the [protocol specification](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/protocol.md) and this package's `fixtures/` for conformance expectations.

## Links

[Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector) · [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [Issues](https://github.com/AmatoGiulio/runtime-inspector/issues)

**Status:** alpha, APIs may change. MIT license.
