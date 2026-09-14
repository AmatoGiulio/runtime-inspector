# Runtime Inspector

Runtime Inspector is a protocol-first developer tool for **live React Native runtime controls**.

A React Native app declares values and actions that are safe to tune while it is running. Interchangeable clients consume the same Runtime Inspector Protocol (RIP), render those controls, and send changes back to the app. The runtime applies updates to Reanimated `SharedValue`-like handles or explicit bindings without routing high-frequency tuning through React state.

The architectural core is the protocol and shared client semantics, not a specific UI.

> **Status — September 2026:** RIP 0.3, the Web panel, React Native runtime SDK, physical-device WebSocket discovery, A/B comparison, copy-as-code, Babel auto-binding, MCP client, and the first Rozenite / React Native DevTools client are implemented. The Rozenite vertical slice is covered by automated bridge/session tests; physical-device React Native DevTools validation is still outstanding and should not be treated as completed.

## What works today

- **RIP 0.3 semantic messages**: `schema.publish`, `schema.dispose`, `control.patch`, `control.commit`, `control.batchPatch`, `control.trigger`, runtime status, handshake, and errors.
- **Shared protocol validation**: Zod message parsing, control-value validation, slider bounds, and conformance fixtures.
- **Multiple schemas and resilient sessions**: schema caching/replay on the broker path, stale schemas, reconnect behavior, and deliberate disposal.
- **Live controls**: slider, toggle, color, spring, bezier, and trigger/action controls.
- **Runtime-native tuning**: values are applied to Reanimated mutable handles / `SharedValue`-like bindings or explicit setters.
- **Low-friction React Native APIs**: `useRuntimeValue`, `useAction`, `useInspector`, the explicit schema/binding API, and `// @inspect` Babel auto-binding.
- **A/B comparison and copy-as-code** through the framework-agnostic `panel-core`.
- **Physical-device WebSocket path**: Metro/LAN discovery, QR output, explicit URL override, and a per-session panel token.
- **MCP client**: schema discovery, single-value updates, committed batch updates, and triggers through the same RIP semantics.
- **React Native DevTools client**: a Rozenite plugin using the official app↔DevTools bridge while reusing `panel-core`; no Rozenite-specific runtime state mirroring is required.

See [Implementation status](docs/implementation-status.md) for the code-vs-doc audit and exact implemented/partial distinctions.

## The model

The runtime declares **what can be controlled**. RIP describes **what the messages mean**. The transport carries those messages. A client decides **how controls are presented**.

```text
Web panel ---- panel-core ---- WebSocket broker --\
                                                  \
MCP client ------------------ WebSocket broker ----> React Native runtime -> SharedValue / binding
                                                  /
Rozenite ----- panel-core ---- Rozenite bridge ----/
```

Rozenite is therefore a client of Runtime Inspector, not its new core.

## One value, one line

```ts
const blur = useRuntimeValue("blur", 18, {
  min: 0,
  max: 40
});
```

`blur` remains a Reanimated mutable handle and appears in every compatible Runtime Inspector client.

Actions are explicit:

```ts
const replay = useAction("replay", () => runReplayAnimation());
```

For grouped controls:

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
```

## Existing code: `// @inspect`

Register `@runtime-inspector/babel-plugin`, then annotate an existing SharedValue declaration:

```ts
// @inspect min=0 max=40
const blur = useSharedValue(18);
```

In development the Babel plugin registers the value in the shared auto schema. In production the declaration remains untouched.

The current DX ladder is:

```text
useRuntimeValue / useAction -> useInspector -> explicit binding API
           ^
      // @inspect for existing SharedValue declarations
```

## Packages

- `@runtime-inspector/protocol` — RIP message/schema types, validation, and conformance fixtures.
- `@runtime-inspector/panel-core` — framework-agnostic schema/value/session semantics, throttling, commits, stale protection, A/B, and export.
- `@runtime-inspector/transport-ws` — local WebSocket broker and routing.
- `@runtime-inspector/react-native` — runtime declarations, bindings, hooks, broker discovery, and the direct RIP-client seam used by local transports.
- `@runtime-inspector/babel-plugin` — dev-only `// @inspect` transform.
- `@runtime-inspector/panel-web` — thin Vite/React renderer over `panel-core`.
- `@runtime-inspector/panel-rozenite` — React Native DevTools/Rozenite renderer and bridge adapter over `panel-core`.
- `@runtime-inspector/client-mcp` — MCP client exposing the running app to AI agents.
- `@runtime-inspector/cli` — local broker/panel startup, LAN/QR discovery, ports, and session token.
- `examples/react-native-reanimated` — Expo/Reanimated example app used by the WebSocket path and the Rozenite vertical slice.

## Run the Web panel

```bash
pnpm install
pnpm dev
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

The CLI starts the local broker and Web panel, prints local/LAN addresses and a QR code, and issues a session token for panel-role clients.

The Web path is:

```text
Web panel -> panel-core -> broker -> RN runtime -> SharedValue / binding
```

## Run the Rozenite / React Native DevTools client

Build the workspace first so the plugin can consume the built workspace packages, then enable Rozenite in the example:

```bash
pnpm install
pnpm build
pnpm --filter @runtime-inspector/example-react-native-reanimated start:rozenite
```

Open React Native DevTools and select **Runtime Inspector**.

The DevTools path is direct:

```text
DevTools panel -> panel-core -> Rozenite bridge -> RN runtime -> SharedValue / binding
```

The Runtime Inspector WebSocket broker is not required for this DevTools path. See [Rozenite architecture](docs/rozenite.md) for the transport decision and reload/stale handling.

## MCP / AI-agent tuning

The MCP client uses the broker transport and connects as another panel-role RIP client:

```bash
RI_BROKER_URL=ws://127.0.0.1:4577 RI_TOKEN=<token> runtime-inspector-mcp
```

It currently exposes `get_schema`, `set_control_value`, `batch_set`, and trigger/action support.

## Protocol status

Current protocol version: **0.3**.

Protocol changes require an RFC in `rfcs/`, conformance fixtures, and protocol documentation before implementation. The Rozenite client required **zero RIP changes**.

See:

- [Protocol](docs/protocol.md)
- [Protocol stability policy](docs/protocol-stability.md)
- [RFC 0001 — protocol 0.3 semantic messages](rfcs/0001-protocol-0.3-semantic-messages.md)
- [RFC 0002 — Babel auto-binding](rfcs/0002-babel-plugin-auto-binding.md)
- [RFC 0003 — Runtime Value model](rfcs/0003-runtime-value-model.md)

## Verification

```bash
pnpm build
pnpm typecheck
pnpm test
```

The repository baseline currently has a known failing test-path issue in the React Native runtime's WebSocket test doubles (`onerror -> close() -> onerror` recursion). It predates the Rozenite client; it is recorded explicitly in [Implementation status](docs/implementation-status.md) rather than being hidden as a new-client regression.

## Non-goals for this phase

- Nitro Modules;
- standalone desktop app;
- VSCode extension;
- recording/timeline tooling;
- generic plugin system;
- production/remote networking;
- monetization work.

## Docs

- [Implementation status](docs/implementation-status.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Protocol stability policy](docs/protocol-stability.md)
- [Getting started](docs/getting-started.md)
- [Rozenite / React Native DevTools client](docs/rozenite.md)
- [MVP roadmap](docs/mvp-roadmap.md)
