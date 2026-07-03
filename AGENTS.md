# Agent Instructions

Runtime Inspector is protocol-first. Preserve that priority.

## Current state (July 2026)

The local loop is validated end-to-end on physical devices, including multi-schema, stale-schema recovery across Metro reloads, and an MCP agent client:

`Panel client -> WebSocket broker -> React Native runtime -> SharedValue -> animation update`

Protocol version: 0.3 (semantic messages: `control.trigger`, `control.commit`, `schema.dispose`). Every protocol change goes through an RFC in `rfcs/` — see [docs/protocol-stability.md](docs/protocol-stability.md) for what counts as breaking. The conformance fixtures in `packages/protocol/fixtures/` are the contract; new messages land with fixtures.

## How work is organized

Multi-agent orchestration model — read [docs/orchestration.md](docs/orchestration.md) before making changes in an agent session.

## Rules

- Keep the protocol package small, typed, and documented.
- Protocol changes require an RFC in `rfcs/` first. Classify every new message in the State/Command/Lifecycle taxonomy (docs/protocol.md).
- Reject invalid values with a reason; never clamp or coerce silently.
- No dynamic `require()` in packages built as ESM — `runtime-react-native` builds CJS specifically to allow guarded requires of optional peers. Do not regress it to ESM-only.
- In the monorepo, `react`, `react-native`, and `react-native-reanimated` must resolve as singletons for the example app (see `examples/react-native-reanimated/metro.config.js`).
- Do not introduce Nitro yet. No desktop app, no plugin system, no recording yet.
- Prefer narrow, testable changes. Every fix lands with the test that would have caught it.
- Keep package APIs ergonomic for React Native developers. DX ladder: explicit API → `useInspector` → `// @inspect` directive.

## Package boundaries

- `packages/protocol` owns shared message/schema types, validation, and conformance fixtures.
- `packages/transport-ws` owns only local transport and routing (rules table in docs/protocol.md).
- `packages/runtime-react-native` owns runtime APIs, binding application, broker discovery, `useInspector`, and the `__riInspect` auto-binding helper.
- `packages/panel-core` owns framework-agnostic panel session logic (connection, values, throttling, A/B compare, export). Panel clients stay thin.
- `packages/panel-web` owns only React rendering over `panel-core`.
- `packages/client-mcp` owns the MCP server exposing the broker to AI agents.
- `packages/babel-plugin` owns the `@inspect` directive transform.
- `packages/cli` owns developer process startup (ports, LAN URLs, QR, session token).

If a change crosses package boundaries, update docs and examples in the same patch.
