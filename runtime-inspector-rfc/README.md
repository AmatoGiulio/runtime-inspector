# Runtime Inspector RFC Pack

Runtime Inspector is a declarative runtime-control protocol and toolchain for tuning real applications on real devices.

This repository starts from documentation first. The objective is to give engineering agents and human contributors enough context to build the first implementation without losing the original product vision.

## Core idea

A target app declares a panel schema. An external client renders that schema as a professional control panel. The client sends live patches back to the app. The runtime applies those patches to animation values, layout values, effects, colors, shaders, or any other bindable runtime state.

The panel is not hardcoded in the app.
The app does not know whether the panel is Web, Desktop, VS Code, DevTools, or CLI.
Both sides speak the Runtime Inspector Protocol.

## Recommended reading order

1. `docs/00-foundation/00-manifesto.md`
2. `docs/00-foundation/01-vision.md`
3. `docs/01-architecture/00-system-overview.md`
4. `docs/02-protocol/00-runtime-inspector-protocol.md`
5. `docs/03-runtime-sdk/00-react-native-runtime-sdk.md`
6. `docs/04-panel/00-panel-renderer.md`
7. `docs/05-transport/00-transport-layer.md`
8. `docs/06-bindings/00-binding-engine.md`
9. `docs/10-examples/00-reanimated-motion-panel.md`

## What this package contains

- Product vision
- Non-goals
- System architecture
- Protocol specification
- Message formats
- Runtime SDK proposal
- Panel renderer architecture
- Transport layer strategy
- Binding engine design
- Plugin system
- Presets and recording
- Developer experience
- Security and performance notes
- Examples and implementation prompts
- SVG diagrams and UI mockups
