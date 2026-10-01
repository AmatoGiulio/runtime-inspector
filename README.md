# Runtime Inspector

**Tune a React Native app while it runs — from a web panel, from React Native DevTools, or from an AI agent — and write the result back into your code.**

Instead of editing a spring, saving, waiting for Fast Refresh and replaying the gesture, you declare the values worth tuning and drag them live on the real device. When it feels right, one click writes the value into the source file it came from.

```ts
const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
```

That line is still a Reanimated shared value. It also appears as a slider in every Runtime Inspector client.

## Why it is different

- **Write-back to source.** "Apply to code" rewrites the declaration that produced a control, located by AST and guarded against manual edits since the app was built. No copy-paste of magic numbers.
- **Agents are first-class clients.** The MCP server exposes the same controls to an AI agent, which tunes the running app (set → observe → repeat) exactly like a human.
- **One protocol, interchangeable panels.** The web panel, the React Native DevTools tab (via [Rozenite](https://github.com/callstackincubator/rozenite)) and the MCP client all speak the Runtime Inspector Protocol (RIP). None of them owns the semantics.
- **Built for motion work.** Spring and Bézier editors with live curves, A/B snapshots, copy-as-TypeScript, trigger actions to replay a transition, and values applied on the UI thread without React re-renders.
- **Zero-ceremony adoption.** Annotate an existing `useSharedValue` with `// @inspect` and it shows up. Production builds are untouched.

The panels are rendered with [DialKit](https://github.com/joshpuckett/dialkit).

## Quick start

```bash
pnpm install
pnpm build
pnpm dev                                                             # broker + web panel
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

`pnpm dev` prints the panel URL (with its session token), LAN addresses and a QR code. Devices find the broker through Metro — simulators, emulators and physical phones on the same network need no configuration.

## Declaring controls

The DX ladder, from least to most ceremony:

```ts
// 1. An existing shared value — just a comment (needs the Babel plugin)
// @inspect min=0 max=40
const blur = useSharedValue(18);

// 2. One value, one line
const glow = useRuntimeValue("glow", 10, { min: 0, max: 48 });
const replay = useAction("replay", () => runReplayAnimation());

// 3. A named, grouped panel
const card = useInspector("card-transition", {
  moveX: { value: 0, min: -120, max: 120, unit: "px" },
  tint: "#f5f7fb",
  spring: { damping: 14, stiffness: 180, onChange: () => runReplayAnimation() },
  replay: () => runReplayAnimation()
});
```

Numbers become sliders (a range is required), booleans toggles, strings colors, `{ damping, stiffness }` springs and four-number arrays Béziers; functions are actions. An explicit schema/binding API sits underneath for full control. See [Getting started](docs/getting-started.md).

To enable `// @inspect`, add `@runtime-inspector/babel-plugin` before `react-native-reanimated/plugin` in `babel.config.js`.

## Three ways to tune

### Web panel

`pnpm dev`, then open the printed URL. Every control, A/B snapshots, TypeScript export, and **Apply to code** (the CLI is the workspace that writes files; set `RUNTIME_INSPECTOR_WORKSPACE_ROOT` when it does not run from the app root).

### React Native DevTools

No broker needed: the DevTools tab talks to the app over Rozenite's own bridge.

1. Wrap Metro with `withRozenite(config, { enabled: process.env.WITH_ROZENITE === "true", include: ["@runtime-inspector/panel-rozenite"] })`.
2. Import the plugin once from your entry: `import "@runtime-inspector/panel-rozenite";`
3. Start Metro with `WITH_ROZENITE=true`, press `j`, and open **Rozenite → Runtime Inspector**.

In this repo: `pnpm --filter @runtime-inspector/example-react-native-reanimated start:rozenite`. Details in [Rozenite client](docs/rozenite.md).

### AI agent (MCP)

```bash
RI_BROKER_URL=ws://127.0.0.1:4577 RI_TOKEN=<token printed by pnpm dev> runtime-inspector-mcp
```

Tools: `get_schema`, `set_control_value`, `batch_set`, `trigger`. Agent writes are committed values; stale schemas are refused with an explicit error.

## How it fits together

```text
Web panel ── panel-core ── WebSocket broker ──┐
MCP agent ──────────────── WebSocket broker ──┼──> React Native runtime ──> SharedValue / binding
DevTools  ── panel-core ── Rozenite bridge ───┘
CLI workspace <── source.apply (Apply to code) ── broker
```

The runtime declares what can be controlled, RIP defines what messages mean, transports carry them, and clients decide presentation. Invalid values are rejected with a reason, never clamped.

## Packages

| Package | Role |
| --- | --- |
| `@runtime-inspector/react-native` | Runtime SDK: hooks, bindings, broker discovery, direct-client seam |
| `@runtime-inspector/babel-plugin` | Dev-only `// @inspect` transform and source anchors |
| `@runtime-inspector/protocol` | RIP types, Zod validation, value validation, conformance fixtures |
| `@runtime-inspector/panel-core` | Framework-agnostic session semantics: values, throttling, commits, stale protection, A/B, export, write-back |
| `@runtime-inspector/panel-dialkit` | The shared DialKit panel used by web and DevTools ([details](docs/dialkit.md)) |
| `@runtime-inspector/panel-web` | Web shell over the shared panel |
| `@runtime-inspector/panel-rozenite` | React Native DevTools plugin and bridge adapter |
| `@runtime-inspector/transport-ws` | Local WebSocket broker |
| `@runtime-inspector/client-mcp` | MCP server for AI agents |
| `@runtime-inspector/cli` | `dev` command: broker, panel, LAN/QR, session token, write-back workspace |

`examples/react-native-reanimated` is an Expo/Reanimated app wired for every path.

## Status

Version 0.1 — protocol **RIP 0.3**. Validated live on a physical Android device (WebSocket path, multi-schema, stale recovery across Metro reloads), in React Native DevTools on the iOS simulator (Rozenite path), and with an agent tuning through MCP. See [Implementation status](docs/implementation-status.md) for exact boundaries.

Protocol changes go through an RFC in [`rfcs/`](rfcs/) with conformance fixtures; see [Protocol](docs/protocol.md) and the [stability policy](docs/protocol-stability.md).

```bash
pnpm build && pnpm typecheck && pnpm test
```

## Workbench experiment

RFC 0005 defines a future Runtime Workbench around the real running app. The `feat/runtime-workbench-m0` branch contains the first bounded spike: explicit runtime probes → 60 Hz recording → broker → timeline graph. Simulator/emulator embedding starts only after that path passes runtime/performance validation.

## Not in scope yet

Full Workbench/device viewport work remains experimental and RFC-governed. Also out of scope for now: native (Nitro) transport, desktop or VS Code apps, a generic plugin system, and production/remote networking.

## Docs

[Getting started](docs/getting-started.md) · [Architecture](docs/architecture.md) · [Protocol](docs/protocol.md) · [DialKit rendering](docs/dialkit.md) · [Rozenite client](docs/rozenite.md) · [Workbench M0](docs/workbench-m0.md) · [iOS viewport M3a](docs/workbench-ios-viewport.md) · [Implementation status](docs/implementation-status.md) · [Roadmap](docs/mvp-roadmap.md) · [Vision](docs/vision.md)

## License

MIT