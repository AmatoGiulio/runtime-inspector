# Agent Instructions

This repository is documentation-first.

Before writing code, read:

1. `README.md`
2. `docs/00-foundation/00-manifesto.md`
3. `docs/01-architecture/00-system-overview.md`
4. `docs/02-protocol/00-runtime-inspector-protocol.md`
5. `docs/10-examples/00-reanimated-motion-panel.md`

## MVP target

Build the smallest end-to-end loop:

```txt
Web Panel slider
-> WebSocket broker
-> React Native Runtime SDK
-> Reanimated SharedValue
-> visual update on device
```

## Do not overbuild

Do not implement every protocol feature immediately.
Do not build desktop, VS Code, plugin marketplace or recording first.
Do not use Nitro until the JS/WebSocket prototype proves the protocol.

## Build order

1. Protocol types
2. Local broker
3. Web panel with sliders
4. RN runtime SDK
5. Reanimated binding
6. JSON preset export
