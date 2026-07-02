# Architecture

Runtime Inspector is split into small workspace packages.

## Packages

- `packages/protocol`: shared TypeScript types, Zod schemas, protocol helpers, examples.
- `packages/runtime-react-native`: runtime SDK used by a React Native app.
- `packages/panel-web`: browser panel that renders controls from a schema.
- `packages/transport-ws`: local broker that routes messages between runtime and panel.
- `packages/cli`: developer command that starts broker and panel.
- `examples/react-native-reanimated`: minimal Expo/Reanimated loop.

## Message flow

1. Runtime connects to the broker and sends `handshake.hello`.
2. Panel connects to the broker and sends `handshake.hello`.
3. Runtime publishes `schema.publish`.
4. Panel renders groups and controls from the schema.
5. Panel sends `control.patch` when a value changes.
6. Broker forwards the patch to runtime clients.
7. Runtime SDK applies the value to the registered binding.

## Binding model

Controls may include a `binding` string. The React Native SDK maps that binding to a target:

- a Reanimated `SharedValue`-like object with a writable `.value`;
- or a setter function.

This keeps the high-frequency update path outside React renders.
