# Rozenite / React Native DevTools client

Status: **implemented and validated in React Native DevTools on the iOS simulator** (Expo Go, SDK 52, 2026-09-27): multi-schema reception, live tuning visible in the app, and DevTools reconnection after an app reload. A physical-device DevTools run is still outstanding.

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

The panel uses `panel-core` for:

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

## Using it in an app

1. Add the packages: `@runtime-inspector/react-native`, `@runtime-inspector/panel-rozenite`, and `@rozenite/metro` (dev).
2. Wrap the Metro config. Keep it conditional so production bundling is unaffected:

   ```js
   const { withRozenite } = require("@rozenite/metro");

   module.exports = withRozenite(config, {
     enabled: process.env.WITH_ROZENITE === "true",
     include: ["@runtime-inspector/panel-rozenite"]
   });
   ```

3. Import the plugin once from the app entry. `@rozenite/metro` does not inject plugin code into the bundle; the import registers the device side of the bridge. It is inert in production and when Rozenite is not enabled:

   ```js
   import "@runtime-inspector/panel-rozenite";
   ```

4. Start Metro with `WITH_ROZENITE=true`, open React Native DevTools (`j` in the Metro terminal) and select **Rozenite → Runtime Inspector**.

No broker, CLI or token is involved. Declarations are unchanged — `useRuntimeValue`, `useAction`, `useInspector` and `// @inspect` appear in DevTools exactly as in the web panel. The app does not mirror values into a Rozenite API.

In this repository the example is already wired:

```bash
pnpm install
pnpm build
pnpm --filter @runtime-inspector/example-react-native-reanimated start:rozenite
```

## Rendering

The panel is the shared DialKit `InspectorPanel` (see [DialKit rendering](dialkit.md)), identical to the web panel except that **Apply to code** is hidden: the direct bridge has no `workspace` client to write files. Use the web panel, or an MCP agent, for write-back.

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

The graphical path — React Native DevTools + Metro + Rozenite + the example app — has been exercised manually on the iOS simulator. That run found and fixed two integration gaps: the example never imported the plugin (so the device bridge never started), and broker discovery logged a warning per connection attempt when only Rozenite was in use. Discovery now warns once per process and backs off after two failed cycles.

Operational note: React Native accepts one debugger connection per app. Another CDP client (for example an agent reloading via CDP) disconnects DevTools; use **Reconnect DevTools** afterwards. If DevTools is opened by hand in a browser, open it on the same host as the inspector WebSocket (`127.0.0.1` vs `localhost`) or Metro closes the connection.

## Architectural note

`panel-core` currently exposes a transport seam named in WebSocket terms (`WebSocketLike`, `createSocket`). Rozenite can use it cleanly, so this integration does not justify a refactor by itself. If a third non-WebSocket client exposes meaningful friction, renaming/extracting a more generic transport interface would then be evidence-driven rather than speculative.
