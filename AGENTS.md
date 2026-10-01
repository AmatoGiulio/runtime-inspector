# Agent Instructions

Runtime Inspector is protocol-first. Preserve that priority.

## Current state (September 2026)

Protocol version 0.3 is implemented and covered by conformance fixtures. The shipped semantic messages include `schema.publish`, `schema.dispose`, `control.patch`, `control.commit`, `control.batchPatch`, `control.trigger`, runtime status, handshake, and protocol errors.

The runtime can expose the same Runtime Inspector Protocol (RIP) state through interchangeable transports/clients:

- Web panel: `panel-web -> panel-core -> WebSocket broker -> React Native runtime`
- MCP: `client-mcp -> WebSocket broker -> React Native runtime`
- React Native DevTools: `panel-rozenite -> panel-core -> Rozenite plugin bridge -> React Native runtime`

The WebSocket path has been validated on physical devices, including multi-schema operation and stale-schema recovery across Metro reloads. The Rozenite client has been exercised inside React Native DevTools on the iOS simulator (2026-09-27); a physical-device DevTools run has not happened yet and should not be claimed. Both human panels render the same DialKit `InspectorPanel`. Source write-back (RFC 0004, `source.apply` to the CLI `workspace` role) is shipped on the broker path. The protocol also includes `source.apply` / `source.applyResult`.

Every RIP protocol change goes through an RFC in `rfcs/` — see [docs/protocol-stability.md](docs/protocol-stability.md). The conformance fixtures in `packages/protocol/fixtures/` are the contract; new protocol messages require fixtures and documentation.

## How work is organized

Read [docs/orchestration.md](docs/orchestration.md) before making broad multi-package changes. Treat implementation and tests as the source of truth when older roadmap prose disagrees with them.

## Rules

- Keep the protocol package small, typed, transport-agnostic, and documented.
- Protocol changes require an RFC first. Classify every new RIP message in the State/Command/Lifecycle taxonomy in `docs/protocol.md`.
- Transport-local lifecycle signals are allowed only when they do not alter RIP semantics; document them as transport details, not protocol messages.
- Reject invalid values with a reason; never clamp or coerce silently.
- No dynamic `require()` in packages built as ESM — `runtime-react-native` builds CJS specifically to allow guarded requires of optional peers. Do not regress it to ESM-only.
- In the monorepo, `react`, `react-native`, and `react-native-reanimated` must resolve as singletons for the example app (see `examples/react-native-reanimated/metro.config.js`).
- Do not introduce Nitro, a generic plugin system, or unrelated product surfaces without a separate decision. Timeline/recording tooling is governed by RFC 0005. M0 recording and M3a browser capture were validated on macOS on 2026-10-01. The explicitly authorized `feat/runtime-workbench-desktop` branch may implement the M3b Electron desktop-shell spike, Simulator discovery/boot, and automatic window attachment. Do not expand that authorization into universal time travel, production packaging/signing, or generic native tooling.
- Prefer narrow, testable changes. Every architectural change lands with the test that would have caught a regression.
- Keep package APIs ergonomic for React Native developers. Current DX ladder: `useRuntimeValue` for a single tunable value, `useAction` for explicit actions, `useInspector` for grouped/advanced controls, explicit schema APIs when full control is needed, and `// @inspect` for Babel auto-binding.
- A client must not reimplement schema storage, value state, patch/commit semantics, stale protection, A/B comparison, or export if `panel-core` already owns that behavior.

## Package boundaries

- `packages/protocol` owns shared RIP message/schema types, validation, and conformance fixtures only.
- `packages/transport-ws` owns the local WebSocket broker/transport and routing.
- `packages/runtime-react-native` owns runtime declarations, binding application, broker discovery, `useRuntimeValue`, `useAction`, `useInspector`, `__riInspect`, and the small direct-protocol client seam used by transport integrations.
- `packages/panel-core` owns framework-agnostic client/session behavior: schemas, cached values, throttling, patch/commit/trigger semantics, stale-schema protection, A/B comparison, and export.
- `packages/panel-dialkit` owns the shared DialKit panel (`InspectorPanel` and control rows) used by web and DevTools — rendering only; session state and RIP semantics stay in `panel-core`.
- `packages/panel-web` is a thin Web shell around `InspectorPanel`.
- `packages/panel-rozenite` owns the Rozenite/React Native DevTools renderer and bridge adapter over `panel-core`; it must not become a second core.
- `packages/client-mcp` owns the MCP server exposing RIP controls to AI agents through the broker.
- `packages/babel-plugin` owns the `@inspect` directive transform.
- `packages/cli` owns developer process startup, LAN/QR discovery, ports, and the session token.

If a change crosses package boundaries, update docs and examples in the same patch.