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

Rendered by the shared DialKit `InspectorPanel` in `panel-dialkit` (also used by Rozenite). Checked in a browser against a live broker: DialKit layout, drag → throttled patches + one commit, and Apply to code round-trip with the result shown in the panel.

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
- copy-as-code;
- Apply to code (per control and per schema) through the CLI workspace.

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

**Validated manually** (iOS simulator, Expo Go SDK 52, 2026-09-27): the Runtime Inspector tab inside React Native DevTools, multiple live schemas, slider tuning visible in the app, and reconnection after an app reload with panel and app values in agreement.

**Outstanding**

- a physical-device React Native DevTools run;
- Apply to code from DevTools (the direct bridge has no `workspace` client; the panel hides the affordance).

## Runtime test isolation and error recovery

Broker discovery warns once per process (not per schema or per attempt) and backs off after two failed candidate cycles (1s doubling to a 10s cap), so an app used only through Rozenite does not churn sockets or flood the console. The WebSocket error handler detaches itself before closing the socket, preventing reentrant `onerror -> close() -> onerror` recursion. A regression test covers that failure and subsequent reconnect/disconnect behavior.

Runtime unit tests use an offline in-memory socket by default; transport-specific suites install their own socket doubles. This avoids accidental native Node WebSocket connections from declaration/hook tests. The former baseline stack-overflow failure is resolved.

## Runtime Workbench / recording — RFC 0005

**M0 validated on macOS, 2026-10-01**

- additive RIP messages for trace schemas and bounded recording lifecycle;
- explicit scalar runtime probes through `useRuntimeProbe`;
- batched 1–60 Hz M0 recorder with a 10 second cap;
- trace-schema caching and recording routing through the WebSocket broker;
- recording state and sequence-gap detection in `panel-core`;
- a Vite Workbench shell with Outline / Runtime / Inspector / Timeline regions;
- the example exposes `card-transition.moveX` as the first probe;
- a real timing → spring transition produced a continuous trace at ~57.2 measured Hz in the observed validation run, with 204 samples and no reported sequence gap.

**M3a validated manually on macOS, 2026-10-01**

- browser-native live window capture in the central Runtime surface;
- explicit Attach/Detach flow;
- capture resolution / reported frame-rate metadata;
- view-only fallback: interaction remains on the actual Simulator window.

**Still not production-ready**

- Android scrcpy viewport;
- physical-device viewport;
- runtime time travel/scrubbing.

M3a validated live Simulator pixels before committing to a desktop shell.

**M3b.1 validated manually on macOS, 2026-10-01**

- Electron 44 desktop shell around the existing Workbench renderer;
- context-isolated preload bridge;
- `simctl` discovery of installed iOS Simulator devices;
- boot/open flow for a selected Simulator target;
- automatic Simulator-window lookup with Electron `desktopCapturer`;
- automatic source grant through Electron's display-media request handler, removing the browser sharing picker;
- browser M3a capture remains available when the Workbench is opened outside Electron.

**M3b.2 reworked on `feat/runtime-workbench-desktop`, pending manual HID validation**

The first CGEvent/`postToPid` implementation was manually tested and did **not** deliver touches to the iOS app surface. It has been removed.

Current spike:

- device-screen crop calibration against a `simctl io screenshot` reference;
- normalized pointer coordinates from the cropped Runtime surface;
- persistent Objective-C helper using SimulatorKit IndigoHID / `SimDeviceLegacyHIDClient`;
- direct touch down/drag/up delivery to the selected Simulator UDID;
- no Accessibility permission dependency for the native HID path;
- pointer input remains transport-local and does not alter RIP semantics.

This uses private Xcode Simulator frameworks. It is viable for a developer tool spike but is an explicit compatibility/maintenance risk and is not yet a permanent product commitment.

**Packaging/TCC requirement recorded**

In development macOS attributed Screen Recording permission to the VS Code host. Release work must package/sign Runtime Inspector and its native helper so Screen Recording is presented under the correct product identity, with first-run permission UX.

**Still outstanding**

- manual validation of IndigoHID tap/drag on the embedded crop;
- Xcode-version compatibility strategy / fallback path;
- multi-touch / keyboard forwarding;
- production packaging/signing and TCC validation.

## Explicitly not implemented in this phase

- Nitro Modules integration;
- standalone desktop application;
- VSCode extension;
- generic plugin system;
- production/remote networking;
- monetization features.