# Architecture

Runtime Inspector is split into small workspace packages.

## Packages

- `packages/protocol`: shared TypeScript types, Zod schemas, protocol helpers, examples.
- `packages/runtime-react-native`: runtime SDK used by a React Native app.
- `packages/panel-core`: framework-agnostic panel session (connection, values store, throttling, A/B compare, export) shared by all panel clients.
- `packages/panel-web`: browser panel that renders controls from a schema; thin React layer over `panel-core`.
- `packages/transport-ws`: local broker that routes messages between runtime and panel.
- `packages/cli`: developer command that starts broker and panel.
- `packages/client-mcp`: MCP server that lets an AI agent tune a running app through the broker as a panel-role client.
- `examples/react-native-reanimated`: minimal Expo/Reanimated loop.

## Design stance

The protocol is the stable core. Everything else is a replaceable client or transport:

- The WebSocket broker is an implementation detail, not part of the contract. A future client may ride an existing bridge instead (e.g. a Rozenite plugin inside React Native DevTools over CDP).
- The broker does not care who sends patches. A panel, a CLI, or an AI agent (e.g. via MCP) are all just `panel`-role clients. Nothing in the protocol assumes a human is on the other side.

## Message flow

1. Runtime connects to the broker and sends `handshake.hello`.
2. Panel connects to the broker and sends `handshake.hello`.
3. Runtime publishes `schema.publish`.
4. Panel renders groups and controls from the schema.
5. Panel sends `control.patch` for in-progress value changes (e.g. a slider drag), and `control.commit` (or a `control.batchPatch` with `committed: true`) for the decided value (drag release, A/B apply, agent decision).
6. Panel sends `control.trigger` to fire a `trigger` control (e.g. "replay transition") — a Command, distinct from a value patch/commit.
7. Broker forwards patches, commits, and triggers to runtime clients.
8. Runtime SDK applies patches and commits to the registered binding the same way, and routes triggers to the trigger registry.
9. On deliberate teardown (screen unmount, hot reload), the runtime sends `schema.dispose` before closing its socket; the broker drops the cached schema and forwards the message to panels.

The broker caches the last published schema per runtime and replays it to panels that connect or reconnect later, so connection order and browser refreshes never strand a panel without a schema. If the publishing runtime disconnects **without** disposing (e.g. mid Metro-reload), the broker keeps the cached schema and broadcasts `runtime.status` so panels can render it **stale** (visible, frozen) instead of empty; a late-joining panel gets the cached schema followed by the current status so it knows immediately whether it's live or stale.

## Binding model

Controls may include a `binding` string. The React Native SDK maps that binding to a target:

- a Reanimated `SharedValue`-like object with a writable `.value`;
- or a setter function.

This keeps the high-frequency update path outside React renders.

A `trigger` control kind maps a binding to a runtime callback (e.g. "replay transition"), so tuning sessions can re-run an animation from the panel without touching the device.

`useInspector` is sugar over this same binding model: it infers a control kind from the shape of each spec value, builds the schema and `${id}.${key}` bindings, and registers them via `bindValue`/`bindTrigger` on the caller's behalf. Reanimated is required: value handles are created with its `makeMutable`, and a missing `makeMutable` export throws an actionable error (install `react-native-reanimated`, or drop to the explicit API for non-animated values) rather than silently falling back to a plain object. Any value entry (slider, spring, bezier, toggle, color) can carry an `onChange` callback — either at the entry's top level (sliders, bare springs) or on a `{ value, label?, onChange? }` wrapper — which fires with the newly-applied value right after the handle's `.value` is written, covering the JS-side-effect cases (re-running an animation, updating a ref) that used to require a manual `bindValue` alongside the hook. The returned handles object also carries `$targets`, a plain mutable record holding the last panel-applied value per value control (initialized to each entry's default), useful for reading "where did the panel leave this" without keeping a separate ref. The schema and handles are constructed once per component instance.

`@runtime-inspector/babel-plugin` (RFC 0002) adds a third entry point onto the same binding model, one level more implicit than `useInspector`: a `// @inspect min=... max=...` directive comment on a `useSharedValue(...)` declaration is rewritten, dev-only, into `__riInspect(useSharedValue(...), "name", meta)`. `__riInspect` (`packages/runtime-react-native/src/auto.ts`) reuses the same control-kind inference `useInspector` uses (extracted into `inferKindFromValue`, shared rather than duplicated), registers the value into a single module-level `"auto"` schema keyed by variable name — re-registering the same name (a re-render or Fast Refresh re-runs the injected call) silently replaces the entry in place, while a genuine collision with a live `useTunable` claim gets a numeric suffix plus a dev warning — and republishes that schema through the ordinary `definePanel`/`connect()` path on a ~100ms debounce so several annotated declarations evaluated in the same render pass coalesce into one publish. Because it rides the same session-replacement logic in `definePanel`, hot reload re-registers the auto schema cleanly like any other panel. In production the helper is a no-op passthrough - the directive comment is inert and the transform never runs.

### Runtime Value model (RFC 0003)

All three entry points register Runtime Values — a name, a handle (or trigger callback), metadata, and an optional `onChange` — and apply panel values through the same setter order (write handle → update target → `onChange`). `useTunable` and the `// @inspect` directive share the module-level registry in `packages/runtime-react-native/src/auto.ts` (`registerRuntimeValue`), publishing into the single "auto" schema; the registry's `dispose()` removes an entry, releases the claimed name, and republishes, so `useTunable` registers/disposes across the mount lifecycle without accumulating name suffixes. `useInspector` builds its own named schema per call but registers each entry the same way; `useTunable` builds its Reanimated mutable once per component (`useRef`). Bindings (`bindValue`/`bindTrigger`/`bindSharedValue`) remain exported as the low-level escape hatch but are private to these three entry points in practice — no documented path requires calling them directly.

## LAN protection

The broker can require a per-session token for `panel`-role clients, generated by the CLI and appended to the printed/QR-encoded panel URL. This is dev-grade protection against other devices on the same LAN sending patches, not real authentication. The `runtime` role is never token-checked, keeping device connection zero-config.

## Device reality

The default broker URL is local, but motion is judged by feel on a physical device. The CLI prints a LAN URL + QR code, and the runtime SDK auto-discovers the broker: it derives the dev machine's host from Metro's `scriptURL` (the same trick Reactotron uses), probes broker ports 4577-4581 on that host, and falls back to the emulator loopback (`10.0.2.2` on Android, `127.0.0.1` otherwise) if nothing answers. `EXPO_PUBLIC_RI_BROKER_URL` remains available as an override for unusual networks.

Discovery reads `scriptURL` from whichever source the runtime exposes, in cascade order, and every path is unit-tested:

| Environment | Source | Fallback behavior |
| --- | --- | --- |
| Expo Go / New Architecture | `TurboModuleRegistry.get("SourceCode")` | next source in cascade |
| Old Architecture | `NativeModules.SourceCode` | next source in cascade |
| Expo Go (extra) | `globalThis.expo.modules.ExponentConstants.experienceUrl` | last resort before loopback-only candidates |
| Android emulator | n/a | `10.0.2.2` loopback candidate always appended |
| iOS simulator | n/a | `127.0.0.1` loopback candidate always appended |
| `adb reverse` (physical Android) | `scriptURL` resolves to `localhost`/LAN host | host-derived candidates probed first |
| Tunnel mode (ngrok/Expo tunnel/Cloudflare/etc.) | `scriptURL` host matches a known tunnel suffix | unsupported — discarded from candidates, explicit one-time dev warning telling the user to use LAN mode or set `EXPO_PUBLIC_RI_BROKER_URL` |
| Release builds | `__DEV__` is false | SDK is a no-op — `definePanel` returns inert `connect`/`disconnect` |

When every candidate in a cycle fails to connect, the SDK also warns once per session with the full candidate list, so a broken broker connection is never silent.
