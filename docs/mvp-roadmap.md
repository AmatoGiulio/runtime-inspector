# MVP Roadmap

Success metric for the summer: **from `runtime-inspector dev` to a working slider on a real device in 60 seconds, zero config** — plus a 45-second demo that sells itself.

## Phase 1: current repo (done)

- Monorepo package structure.
- Protocol types and validation.
- Local WebSocket broker.
- Minimal web panel.
- Minimal React Native SDK.
- Reanimated example.
- Documentation for future agents.

## Phase 2: make the loop bulletproof (July)

Ordered by impact:

1. **Schema cache in the broker.** Done: the broker stores the last `schema.publish` per runtime and replays it to panels that connect or refresh later.
2. **Reconnect behavior** on both runtime and panel. Basic reconnect is implemented; next pass should add visible retry diagnostics and configurable backoff.
3. **Physical device support.** Animations are judged by feel on a real device, not in the simulator. CLI prints LAN URL + QR code (Expo-style); document `adb reverse` for Android USB. Remove the hardcoded `127.0.0.1` assumption from the runtime SDK.
4. **Copy as code.** First pass implemented: the panel exports current values as paste-ready TypeScript. Next pass should generate control-aware snippets such as `withSpring(x, { damping: 14, stiffness: 180 })` and `Easing.bezier(...)`.
5. **Trigger control.** First pass implemented: a `trigger` control kind invokes a callback registered in the runtime, so a full tuning session can happen from the desktop without touching the device.
6. **Patch throttling** on high-frequency controls. First pass implemented for sliders in the web panel; values update immediately in UI while WebSocket patches are capped during drag and flushed on release.
7. Runtime-side Zod validation of incoming messages (broker already validates; runtime currently does raw `JSON.parse`).
8. Better panel control state and error display.

## Phase 3: richer tuning (July/August)

- Spring editor UI with live curve preview.
- Bezier editor UI.
- **A/B compare**: hold two parameter sets and switch between them instantly while re-triggering the animation. Motion tuning is comparative by nature; no existing tool offers this. Small superset of the preset model already in the protocol.
- Control metadata for display density and labels.
- Better color formats.

## Phase 4: distribution (August)

- **Rozenite client**: a React Native DevTools plugin speaking the same protocol. Distribution inside the official DevTools ecosystem, and the concrete proof of the "protocol-first, interchangeable panels" thesis.
- **AI agent client**: an MCP server that connects to the broker as a panel-role client, letting an agent tune animations iteratively (patch → observe → repeat). No competitor does this; the architecture already allows it. At minimum, a demo for the launch post.
- Launch: 45-second demo video (spring tuning + copy-as-code + agent tuning), posts on r/reactnative, X, SWM/Expo communities.

## Later

- Dev-only auto-binding (Babel plugin registering `useSharedValue` automatically) — the jump from "tool you configure" to "tool you switch on".
- Desktop and VSCode clients.
- Native module path if JS transport becomes limiting.
- Recording and timeline tools.
- Plugin system only after the core protocol proves stable.
- Designer↔dev remote collaboration (tunnel) as a possible paid product — explicitly out of scope this summer.
