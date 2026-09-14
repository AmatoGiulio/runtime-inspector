# Runtime Inspector

Runtime Inspector is a protocol-first developer tool for **live React Native runtime controls**.

Instead of only observing runtime state, an app can declare values and actions that are safe to tune while it is running. A client renders those controls and sends live updates back to the app; the runtime applies them to Reanimated `SharedValue`-like handles or explicit bindings without routing every high-frequency update through React state.

The architectural core is the **Runtime Inspector Protocol**, not a specific UI. The web panel is the reference client today, the same protocol already serves an MCP client for AI agents, and a React Native DevTools client built with Rozenite is the next integration target.

> **Status — September 2026:** the runtime loop, protocol, web panel, physical-device discovery, A/B compare, copy-as-code, dev-only auto-binding, and MCP client are implemented. The Rozenite client is planned, not shipped yet.

## What works today

- **Zero-config physical-device support**: the runtime SDK discovers the broker from Metro's script URL. Run the app on a real device on the same Wi-Fi and it connects without an env var in the common Expo/RN workflow. `EXPO_PUBLIC_RI_BROKER_URL` remains available as an override.
- **Live controls**: slider, toggle, color, bezier with curve preview, spring editor, and `trigger` controls for actions such as replaying an animation.
- **Runtime-native tuning**: values are applied to Reanimated mutable handles / `SharedValue`-like bindings rather than through React state.
- **Copy as code**: export tuned values as paste-ready TypeScript, including Reanimated `withSpring` and `Easing.bezier` snippets.
- **A/B compare**: save two value snapshots, switch between them, and auto-replay when a replay trigger is available.
- **Resilient sessions**: broker-side schema cache and replay, reconnect on both ends, explicit stale-schema state, and shared protocol validation.
- **Hardened dev handshake**: protocol version enforcement plus a per-session token protecting patch-sending panel clients on the LAN.
- **AI-agent client**: `runtime-inspector-mcp` can read schemas, set values, batch changes, and fire triggers through the same protocol used by the web panel.
- **Dev-only auto-binding**: `// @inspect` can turn an existing `useSharedValue` declaration into an inspectable runtime value at build time.

## The model

The runtime declares **what can be controlled**. The protocol describes **how clients talk to it**. A client decides **how those controls are presented**.

```text
Web panel ─┐
MCP agent ─┼─> Runtime Inspector Protocol -> React Native runtime -> SharedValue / binding
Rozenite  ─┘   (next client)
```

That separation is deliberate: Rozenite/React Native DevTools is a natural host for the UI, but it is not an architectural dependency of the runtime-control model.

## Declare controls in one hook

`useInspector` infers a control kind from the shape of each spec value, builds the panel schema, and returns mutable handles — no manual `definePanel` / `bindSharedValue` wiring required:

```ts
const card = useInspector("card-transition", {
  moveX: { value: 0, min: -120, max: 120, unit: "px" },
  color: "#f5f7fb",
  spring: {
    damping: 14,
    stiffness: 180,
    onChange: () => runReplayAnimation()
  },
  replay: () => runReplayAnimation()
});

// card.moveX, card.color and card.spring are SharedValue-like handles.
// card.replay is registered as a trigger.
// card.$targets.moveX contains the last panel-applied value.
```

`useInspector` requires `react-native-reanimated` as a peer dependency and creates handles with Reanimated's `makeMutable`. The explicit API (`definePanel`, `bindSharedValue`, `bindValue`, `bindTrigger`, ...) remains available underneath for cases that need direct control or do not use Reanimated.

## One value, one line

For a single tunable value, `useRuntimeValue` skips the panel/spec ceremony:

```ts
const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
// A Reanimated mutable handle that also appears in the shared "auto" panel.

const replay = useAction("replay", () => runReplayAnimation());
// Renders as an action/trigger in the same auto panel.
```

Kind inference is shared with `useInspector`: a number requires `min` / `max`, booleans become toggles, strings become colors, spring-shaped objects become spring editors, and 4-number arrays become beziers. Actions are explicit through `useAction`.

## Switch it on with a comment

The DX ladder is:

`// @inspect` -> `useRuntimeValue` / `useAction` -> `useInspector` -> explicit binding API

Annotate an existing `useSharedValue`:

```ts
// @inspect min=-120 max=120 step=1 unit=px label="Move X"
const moveX = useSharedValue(0);
```

Register the Babel plugin:

```js
module.exports = {
  plugins: ["@runtime-inspector/babel-plugin", "react-native-reanimated/plugin"]
};
```

In development the plugin rewrites the declaration to the internal `__riInspect(...)` helper and registers it in the shared auto schema. Numeric values require an explicit range. Production builds leave the declaration untouched and the comment is inert.

## Packages

- `@runtime-inspector/protocol`: protocol types, Zod validation, value validation, and conformance fixtures.
- `@runtime-inspector/panel-core`: framework-agnostic panel session logic — connection state, values, throttling, A/B compare, export, stale schemas.
- `@runtime-inspector/transport-ws`: local WebSocket broker for runtime/client messages.
- `@runtime-inspector/react-native`: React Native runtime SDK and broker discovery.
- `@runtime-inspector/babel-plugin`: dev-only `// @inspect` transform.
- `@runtime-inspector/panel-web`: Vite/React reference panel built on `panel-core`.
- `@runtime-inspector/client-mcp`: MCP client exposing the running app to AI agents.
- `@runtime-inspector/cli`: `runtime-inspector dev` command.
- `examples/react-native-reanimated`: Expo/Reanimated example app.

## Run it

```bash
pnpm install
pnpm dev
```

The dev command starts the local broker and web panel. By default:

- broker: `ws://127.0.0.1:4577`
- panel: `http://127.0.0.1:4578?token=<session token>`

The CLI prints local/LAN URLs and a QR code, and falls forward to the next available port if a default port is occupied.

Then start the example:

```bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

On a physical device on the same Wi-Fi, the runtime discovers the broker automatically. The basic loop is:

```text
Panel control -> broker -> RN runtime -> SharedValue / binding -> live result on device
```

### AI-agent tuning (MCP)

The CLI also prints the values needed to launch the MCP client:

```bash
RI_BROKER_URL=ws://127.0.0.1:4577 RI_TOKEN=<token> runtime-inspector-mcp
```

The MCP client currently exposes schema discovery, single-value updates, batch updates, and triggers. It connects as another panel-role client; the protocol does not special-case human vs agent control.

## Protocol status

The core has already moved beyond the original proof of concept:

- `panel-core` is extracted from the web UI;
- protocol `0.3` has semantic `control.trigger`, `control.commit`, `schema.dispose`, and stale-runtime behavior;
- conformance fixtures cover the protocol contract;
- runtime sessions support multiple schemas and deliberate disposal;
- the Runtime Value model is shared by `useInspector`, `useRuntimeValue`, `useAction`, and `// @inspect`.

See [RFC 0001](rfcs/0001-protocol-0.3-semantic-messages.md), [RFC 0002](rfcs/0002-babel-plugin-auto-binding.md), and [RFC 0003](rfcs/0003-runtime-value-model.md).

## Next milestone

The next milestone is **distribution and polish**, not another rewrite of the core:

1. build the Rozenite / React Native DevTools client on top of `panel-core`;
2. finish the spring visualization/panel polish;
3. tighten diagnostics and reconnect UX;
4. produce a short physical-device demo covering tuning, A/B, copy-as-code, and agent-driven control.

See the [current roadmap](docs/mvp-roadmap.md).

## Non-goals for this phase

- Nitro module;
- standalone desktop app;
- VSCode extension;
- general plugin system;
- recording/timeline engine;
- production networking or remote collaboration.

Those remain possible later, but the current goal is a small, stable runtime-control protocol with excellent local developer experience.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
```

## Docs

- [Vision](docs/vision.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Protocol stability policy](docs/protocol-stability.md)
- [Getting started](docs/getting-started.md)
- [MVP roadmap](docs/mvp-roadmap.md)

The original documentation-first RFC pack remains under `runtime-inspector-rfc/` as source material.
