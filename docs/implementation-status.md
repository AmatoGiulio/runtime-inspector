# Implementation status

This document is a code-and-test inventory, not a roadmap. When older prose disagrees with implementation or tests, implementation/tests are authoritative.

Status vocabulary:

- **implemented** — present in code and exercised by existing tests or by the current client implementation;
- **partially implemented** — meaningful code exists, but an important validation or behavior is incomplete;
- **planned** — not implemented and should not be presented as current functionality.

## Protocol 0.3

**Implemented**

- `schema.publish`
- `schema.dispose`
- `control.patch`
- `control.commit`
- `control.batchPatch`
- `control.trigger`
- `runtime.status`
- handshake accept/reject and protocol version enforcement
- shared Zod message parsing/validation
- value validation by control kind, including slider bounds and finite-number validation
- protocol conformance fixtures

No Rozenite-specific RIP message was added.

## Session / panel behavior

**Implemented in `panel-core`**

- multiple schemas;
- per-schema values;
- throttled preview patches;
- explicit commits;
- triggers;
- incoming patch/commit/batch application;
- stale-schema protection;
- cached/replayed schema consumption;
- reconnect behavior for its socket-backed session;
- A/B slots and committed batch apply;
- copy-as-TypeScript export.

The core is framework-agnostic at the state/semantics level. Its injected transport seam is still named `WebSocketLike`; Rozenite currently fits that seam without requiring a core rewrite.

## Web panel

**Implemented**

- slider;
- toggle;
- color;
- spring editor;
- bezier editor/preview;
- trigger/replay action;
- multi-schema UI;
- stale state;
- A/B comparison;
- copy-as-code.

Older text claiming that spring/bezier were only reserved for a future pass is stale.

## React Native runtime

**Implemented**

- explicit `definePanel` API;
- `bindSharedValue`, `bindValue`, `bindTrigger`;
- SharedValue/Reanimated application path;
- `useInspector`;
- `useRuntimeValue`;
- `useAction`;
- `// @inspect` Babel auto-binding;
- runtime-side patch, commit, batch patch, and trigger application;
- multiple runtime sessions/schemas;
- schema disposal;
- broker discovery from Metro / LAN override;
- reconnect to the WebSocket broker;
- direct RIP client attachment used by transport-local clients such as Rozenite.

## CLI / physical-device path

**Implemented**

- local WebSocket broker + web panel startup;
- LAN address output;
- QR output;
- automatic physical-device broker discovery in the common Metro LAN path;
- explicit broker URL override;
- per-session panel token.

The existing WebSocket/physical-device path predates the Rozenite work and is separate from the direct DevTools bridge.

## MCP client

**Implemented**

- `get_schema`;
- `set_control_value`;
- `batch_set`;
- trigger/action support;
- broker/session-token connection as a panel-role RIP client.

## Rozenite / React Native DevTools

**Implemented in the current Rozenite client branch**

- a real Rozenite panel registered in React Native DevTools;
- direct app-to-DevTools RIP carriage via `@rozenite/plugin-bridge`;
- `panel-core` reuse rather than duplicated client semantics;
- multi-schema reception;
- live/stale schema distinction;
- slider, toggle, color, trigger, spring, and bezier rendering;
- live patch + committed value flow;
- trigger flow;
- runtime generation replacement / re-handshake;
- stale protection across generation replacement;
- A/B and copy-as-code through `panel-core`;
- example Metro wiring through `@rozenite/metro`.

**Partially implemented / validation outstanding**

- the actual graphical React Native DevTools + Metro + physical-device path has not yet been manually exercised in the current execution environment. Automated bridge tests use Rozenite's official in-memory channel and are passing, but they are not a substitute for that device validation.

## Known verification issue

The repository baseline already had a failing `pnpm test` gate before Rozenite changes: runtime WebSocket test doubles can recurse through `onerror -> close() -> onerror` and overflow the stack in runtime hook/auto-binding tests. Build and typecheck passed on the baseline.

This is separate from the new direct Rozenite path; the new Rozenite bridge tests and direct-runtime protocol-client tests are independently exercised. The baseline failure should be fixed as a focused follow-up rather than hidden or mislabeled as a Rozenite regression.

## Explicitly not implemented in this phase

- Nitro Modules integration;
- standalone desktop application;
- VSCode extension;
- recording/timeline tooling;
- generic plugin system;
- production/remote networking;
- monetization features.
