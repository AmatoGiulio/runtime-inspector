# Agent Instructions

Runtime Inspector is protocol-first. Preserve that priority.

## Current goal

Validate the local loop:

`Web Panel slider -> WebSocket broker -> React Native runtime -> SharedValue -> animation update`

## Rules

- Keep the protocol package small, typed, and documented.
- Do not introduce Nitro yet.
- Do not build a desktop app yet.
- Do not build a plugin system yet.
- Do not add recording yet.
- Prefer narrow, testable changes.
- Keep package APIs ergonomic for React Native developers.

## Package boundaries

- `packages/protocol` owns shared message and schema types.
- `packages/transport-ws` owns only local transport and routing.
- `packages/runtime-react-native` owns runtime APIs and binding application.
- `packages/panel-web` owns UI generation from schema.
- `packages/cli` owns developer process startup.

If a change crosses package boundaries, update docs and examples in the same patch.
