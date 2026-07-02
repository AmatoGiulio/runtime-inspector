# Runtime Inspector

Runtime Inspector is a protocol-first developer tool for React Native runtime controls.

An app declares a typed panel schema. A Web/Desktop/VSCode panel reads that schema, renders controls automatically, and sends live patches back to the app. The runtime applies those patches to `SharedValue`, Reanimated, or native values without routing every update through React state.

The panel is not the product core. The Runtime Inspector Protocol is.

## Current MVP

This repository is ready for early development. It contains:

- `@runtime-inspector/protocol`: TypeScript protocol types and Zod validation.
- `@runtime-inspector/transport-ws`: local WebSocket broker for runtime/panel messages.
- `@runtime-inspector/react-native`: minimal React Native runtime SDK.
- `@runtime-inspector/panel-web`: Vite web panel that renders schema controls.
- `@runtime-inspector/cli`: `runtime-inspector dev` command.
- `examples/react-native-reanimated`: Expo/Reanimated example.

## Install

```bash
pnpm install
```

## Run the inspector

```bash
pnpm dev
```

This starts:

- broker: `ws://127.0.0.1:4577`
- web panel: `http://127.0.0.1:4578`

Then run the React Native example:

```bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

Open the panel and move the sliders. The desired loop is:

`Web Panel slider -> WebSocket broker -> RN runtime -> SharedValue -> updated animation`

## Development

```bash
pnpm build
pnpm typecheck
```

## Non-goals for this phase

- No Nitro module.
- No desktop app.
- No VSCode extension.
- No plugin system.
- No recording engine.
- No production networking.

The first milestone is a stable declarative protocol and a working local loop.

## Docs

- [Vision](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Getting started](docs/getting-started.md)
- [MVP roadmap](docs/mvp-roadmap.md)

The old documentation-first RFC pack remains under `runtime-inspector-rfc/` as source material.
