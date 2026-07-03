# Runtime Inspector

Runtime Inspector is a protocol-first developer tool for React Native runtime controls.

An app declares a typed panel schema. A Web/Desktop/VSCode panel reads that schema, renders controls automatically, and sends live patches back to the app. The runtime applies those patches to `SharedValue`, Reanimated, or native values without routing every update through React state.

The architectural core is the Runtime Inspector Protocol, not the panel: the web panel is the reference client, and the same protocol already serves an AI-agent client via MCP, with a React Native DevTools (Rozenite) plugin planned. The product bar, though, is developer experience: 60 seconds from `runtime-inspector dev` to a working slider on a real device, and tuned values that flow back into code ("copy as code").

## What works today

- **Zero-config device support**: the runtime SDK discovers the broker from Metro's script URL — launch the app on a real device on the same Wi-Fi and it connects on its own. `EXPO_PUBLIC_RI_BROKER_URL` remains as an override.
- **Live controls**: slider, toggle, color, bezier (with curve preview), spring editor, and `trigger` to replay animations from the panel.
- **Copy as code**: export tuned values as paste-ready TypeScript with Reanimated `withSpring`/`Easing.bezier` snippets.
- **A/B compare**: save two value snapshots, switch between them with an auto-replay.
- **Resilient loop**: broker-side schema cache and replay, reconnect on both ends, shared protocol validation on every hop.
- **Hardened handshake**: protocol version enforcement plus a per-session token (embedded in the panel URL/QR) protecting patch-sending clients on the LAN.
- **AI-agent client**: an MCP server (`runtime-inspector-mcp`) that connects as a panel-role client, so an agent can read the schema, patch values, and fire replays iteratively.

## Declare controls in one hook

`useInspector` infers a control kind from the shape of each spec value, builds the panel schema, and returns mutable handles — no manual `definePanel`/`bindSharedValue` wiring required:

```ts
const card = useInspector("card-transition", {
  moveX: { value: 0, min: -120, max: 120, unit: "px" },
  color: "#f5f7fb",
  spring: { damping: 14, stiffness: 180, onChange: () => runReplayAnimation() },
  replay: () => runReplayAnimation()
});

// card.moveX, card.color, card.spring are SharedValue-like handles;
// card.replay is the function itself, registered as a trigger.
// card.$targets.moveX is the last panel-applied value for that control.
```

`useInspector` requires `react-native-reanimated` as a peer dependency — it creates handles with Reanimated's `makeMutable`. The explicit API (`definePanel`, `bindSharedValue`, `bindValue`, `bindTrigger`, …) is still there underneath and works without Reanimated, for cases that need direct control over bindings or side effects.

## One value, one line

For a single tunable value, `useRuntimeValue` skips the panel/spec ceremony entirely — no id to invent, no group:

```ts
const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
// blur is the runtime-native mutable value - in React Native, a Reanimated
// SharedValue: use it in worklets/styles as usual.
// It shows up in the shared "auto" panel alongside every other useRuntimeValue
// and // @inspect value, with no grouping to set up.

const replay = useAction("replay", () => runReplayAnimation());
// The panel renders a button in the same "auto" panel. `replay` is the
// function itself - actions are declared explicitly, not inferred.
```

Kind inference is the same table `useInspector` uses (number requires `min`/`max`, boolean → toggle, string → color, spring shape → spring editor, 4-number array → bezier). Actions are not inferred from a function initial — use `useAction("replay", fn)` instead. It registers on mount and unregisters on unmount, so removing the component removes its control from the panel.

## Switch it on with a comment

The DX ladder, in order: `// @inspect` (zero API, build-time) → `useRuntimeValue` / `useAction` (one line, runtime-level) → `useInspector` (grouped panels, `onChange`, `$targets`) → the explicit API (full control, no Reanimated required).

Annotate an existing `useSharedValue` with an `// @inspect` comment and `@runtime-inspector/babel-plugin` does the rest at build time, dev-only:

```ts
// @inspect min=-120 max=120 step=1 unit=px label="Move X"
const moveX = useSharedValue(0);
```

Register the plugin in `babel.config.js`:

```js
module.exports = {
  plugins: ["@runtime-inspector/babel-plugin", "react-native-reanimated/plugin"]
};
```

The plugin rewrites the declaration to `__riInspect(useSharedValue(0), "moveX", { min: -120, max: 120, ... })`, auto-importing `__riInspect` from `@runtime-inspector/react-native`. Numeric values require `min`/`max` (a build-time error otherwise, mirroring `useInspector`'s bare-number rule); the control kind is inferred the same way `useInspector` infers it. Production builds leave the code untouched — the comment stays inert.

## Packages

- `@runtime-inspector/protocol`: TypeScript protocol types, Zod validation, shared value validation, conformance fixtures.
- `@runtime-inspector/panel-core`: framework-agnostic panel session logic (connection, values, throttling, A/B compare, export) — the base for every panel client.
- `@runtime-inspector/transport-ws`: local WebSocket broker for runtime/panel messages.
- `@runtime-inspector/react-native`: React Native runtime SDK with zero-config broker discovery.
- `@runtime-inspector/babel-plugin`: dev-only Babel plugin that auto-binds `// @inspect`-annotated `useSharedValue`s (see [RFC 0002](rfcs/0002-babel-plugin-auto-binding.md)).
- `@runtime-inspector/panel-web`: Vite web panel that renders schema controls.
- `@runtime-inspector/client-mcp`: MCP server exposing the broker to AI agents.
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
- web panel: `http://127.0.0.1:4578?token=<session token>`

The CLI prints local and LAN URLs plus a QR code for the panel. If either port is busy, it picks the next available port and prints the URLs to use. Open the panel through the printed URL — the token in it authorizes the panel with the broker.

Then run the React Native example:

```bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

On a real device on the same Wi-Fi, the app finds the broker by itself — no env vars. Open the panel and move the sliders. The loop is:

`Web Panel slider -> WebSocket broker -> RN runtime -> SharedValue -> updated animation`

### AI-agent tuning (MCP)

The CLI also prints a ready-to-use line to launch the MCP client:

```bash
RI_BROKER_URL=ws://127.0.0.1:4577 RI_TOKEN=<token> runtime-inspector-mcp
```

Register it with any MCP-capable agent and it can read the schema, patch values, and fire replay triggers — the broker treats it as just another panel.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Next up

See [MVP roadmap](docs/mvp-roadmap.md). The core is consolidated: `panel-core` extracted, protocol 0.3 semantic messages (`control.trigger`, `control.commit`, `schema.dispose`, stale schemas across reloads) shipped via [RFC 0001](rfcs/0001-protocol-0.3-semantic-messages.md) with a conformance fixture suite. Next: spring curve preview in the panel, the Rozenite/DevTools client on top of `panel-core`, and the launch pass (45-second demo: spring tuning by feel, copy as code, agent tuning).

## Non-goals for this phase

- No Nitro module.
- No desktop app.
- No VSCode extension.
- No plugin system.
- No recording engine.
- No production networking.

The first milestone is a stable declarative protocol and a working local loop that is bulletproof on a real device.

## Docs

- [Vision](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Protocol stability policy](docs/protocol-stability.md)
- [Getting started](docs/getting-started.md)
- [MVP roadmap](docs/mvp-roadmap.md)

The old documentation-first RFC pack remains under `runtime-inspector-rfc/` as source material.
