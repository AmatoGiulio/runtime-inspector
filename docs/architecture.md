# Architecture

Runtime Inspector is split into small workspace packages.

## Packages

- `packages/protocol`: shared TypeScript types, Zod schemas, protocol helpers, examples.
- `packages/runtime-react-native`: runtime SDK used by a React Native app.
- `packages/panel-web`: browser panel that renders controls from a schema.
- `packages/transport-ws`: local broker that routes messages between runtime and panel.
- `packages/cli`: developer command that starts broker and panel.
- `examples/react-native-reanimated`: minimal Expo/Reanimated loop.

## Design stance

The protocol is the stable core. Everything else is a replaceable client or transport:

- The WebSocket broker is an implementation detail, not part of the contract. A future client may ride an existing bridge instead (e.g. a Rozenite plugin inside React Native DevTools over CDP).
- The broker does not care who sends patches. A panel, a CLI, or an AI agent (e.g. via MCP) are all just `panel`-role clients. Nothing in the protocol assumes a human is on the other side.

## Message flow

1. Runtime connects to the broker and sends `handshake.hello`.
2. Panel connects to the broker and sends `handshake.hello`.
3. Runtime publishes `schema.publish`.
4. Panel renders groups and controls from the schema.
5. Panel sends `control.patch` when a value changes.
6. Broker forwards the patch to runtime clients.
7. Runtime SDK applies the value to the registered binding.

Planned (Phase 2): the broker caches the last published schema per runtime and replays it to panels that connect or reconnect later, so connection order and browser refreshes never strand a panel without a schema.

## Binding model

Controls may include a `binding` string. The React Native SDK maps that binding to a target:

- a Reanimated `SharedValue`-like object with a writable `.value`;
- or a setter function.

This keeps the high-frequency update path outside React renders.

Planned (Phase 2): a `trigger` control kind maps a binding to a runtime callback (e.g. "replay transition"), so tuning sessions can re-run an animation from the panel without touching the device.

## Device reality

The default broker URL is local, but motion is judged by feel on a physical device. Phase 2 makes the CLI print a LAN URL + QR code and removes the hardcoded loopback assumption from the runtime SDK (`adb reverse` documented for Android USB).
