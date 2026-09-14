# Rozenite / React Native DevTools client

Status: **implemented vertical slice; automated bridge/session coverage is in place. Physical-device DevTools validation is still required before calling the integration fully validated.**

Runtime Inspector remains protocol-first. Rozenite is a client and transport host, not a replacement for the Runtime Inspector Protocol (RIP) or `panel-core`.

## Architecture

```text
React Native DevTools
  Runtime Inspector panel
          |
          v
      panel-core
          |
  RozenitePanelSocket
          |
 @rozenite/plugin-bridge
          |
   react-native.ts
          |
attachRuntimeInspectorProtocolClient
          |
 existing runtime sessions / bindings
          |
 SharedValue / bindValue / bindTrigger
```

RIP messages cross the Rozenite bridge unchanged. `schema.publish`, `schema.dispose`, `control.patch`, `control.commit`, `control.batchPatch`, `control.trigger`, `runtime.status`, handshake messages, and protocol errors retain their existing meaning and validation.

No protocol change was required for this client.

## Why the direct Rozenite bridge

The first implementation does **not** connect the DevTools panel back to Runtime Inspector's WebSocket broker.

Rozenite already provides an official bidirectional channel between the DevTools panel and code running in the React Native application. Using that channel directly has three concrete advantages:

1. React Native DevTools does not need the Runtime Inspector CLI, LAN address, QR discovery, or broker session token merely to control the app it is already debugging.
2. RIP stays transport-independent: the same semantic messages are carried by either the WebSocket broker or Rozenite.
3. `panel-core` remains the single implementation of client/session behavior. The Rozenite package adapts its bridge to the existing `WebSocketLike` / `createSocket` seam rather than copying schema/value/A-B/export logic.

The WebSocket broker remains the correct path for the Web panel and MCP client. This is intentionally not a broker replacement.

## Runtime generation / reload handling

Rozenite adds one **transport-local** event, `runtime-inspector:ready`, carrying the RIP version and a runtime generation id. It is not a RIP message and does not change the protocol.

When the device-side Rozenite entry is recreated after a reload, the panel adapter:

1. marks schemas known from the previous runtime generation offline through existing `runtime.status` semantics;
2. replays the panel handshake;
3. receives the currently active schemas again;
4. lets `panel-core` revive republished schemas while keeping schemas that did not return visible-but-stale.

This preserves the existing stale-schema model rather than creating a Rozenite-specific lifecycle model.

## Supported client behavior

The current panel uses `panel-core` for:

- multiple schemas;
- cached values;
- stale-schema protection;
- throttled `control.patch` updates;
- final `control.commit` updates;
- `control.trigger` actions;
- A/B save/apply;
- copy-as-TypeScript export.

The renderer supports:

- slider;
- toggle;
- color;
- trigger/action;
- spring;
- bezier.

## Example

The existing Expo/Reanimated example is Rozenite-enabled without adding Rozenite-specific state declarations to `App.tsx`.

Build the workspace first, then start the example with Rozenite enabled:

```bash
pnpm install
pnpm build
pnpm --filter @runtime-inspector/example-react-native-reanimated start:rozenite
```

Open React Native DevTools and select the **Runtime Inspector** panel.

The declaration model remains unchanged:

```ts
const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
```

or:

```ts
// @inspect min=0 max=40
const blur = useSharedValue(18);
```

Grouped controls still use `useInspector(...)`; actions still use `useAction(...)`.

The app does not mirror values into a Rozenite API.

## Validation

Automated tests use Rozenite's official `@rozenite/testing` in-memory channel and the actual `getRozeniteDevToolsClient` API. Coverage includes:

- multi-schema reception;
- patch;
- commit;
- trigger;
- runtime generation replacement / re-handshake;
- stale-schema protection;
- direct runtime schema replay and disposal;
- protocol version mismatch.

What is **not** yet proven by automated CI is the full graphical React Native DevTools + Metro + physical-device path. That is the next manual validation step, not an implemented protocol feature.

## Architectural note

`panel-core` currently exposes a transport seam named in WebSocket terms (`WebSocketLike`, `createSocket`). Rozenite can use it cleanly, so this integration does not justify a refactor by itself. If a third non-WebSocket client exposes meaningful friction, renaming/extracting a more generic transport interface would then be evidence-driven rather than speculative.
