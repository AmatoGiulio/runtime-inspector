# RFC 0009 — DartNative runtime adapter (experimental)

Status: **research / opt-in spike**, not an implementation promise.

## Motivation

DartNative (DN) exposes native iOS/Android views from Dart and supports an
`AnimationController`, `AnimationController.fling(velocity:, spring:)`,
`CurvedAnimation`, tweens and animated widgets. Developers can already animate;
the missing workflow we want to investigate is **tuning parameters in a running
DN app and feeling the next gesture immediately**, then eventually applying a
confirmed change back to Dart source. This is the same developer problem as the
React Native Runtime Inspector, but not the same engine or discovery mechanism.

## Evidence and unknowns (2026-10-20)

- [DN's public widget reference](https://github.com/DartNative/dartnative/blob/main/docs/widgets.md)
  explicitly lists the animation primitives, including `fling` with a spring.
- [DN's architecture](https://github.com/DartNative/dartnative/blob/main/docs/architecture.md)
  puts Dart and native views on the platform main thread. System navigation and
  keyboard animations run through platform animation machinery, not necessarily
  user-configurable `AnimationController` instances.
- [The official plugin guide](https://github.com/DartNative/dartnative/blob/main/docs/plugin_development.md)
  supports plugins without native views and plugins with native FFI views. An
  opt-in tuning runtime can start as **pure Dart**, using `dart:io` WebSocket,
  without adding Swift/Kotlin or a custom native view.
- [DN's hot reload documentation](https://dartnative.com/docs/debugging/hot-reload/)
  describes retained native-side state across Dart hot restart. The runtime
  must dispose or replace stale connections/registrations safely.
- [DN's getting-started guide](https://github.com/DartNative/dartnative/blob/main/docs/getting_started.md)
  describes an officially supported DartNative IDE extension for VS Code,
  Cursor and Antigravity, and a Dart VM service exposed by `dn run`. Its
  extension protocol is a separate candidate for later investigation, not an
  assumed integration point for this spike.
- DN's framework implementation is private. There is no verified public hook
  to enumerate arbitrary active controllers, intercept platform animation
  transactions, or dynamically rewrite Dart source. **Automatic discovery is
  unproven.** The generic Flutter DevTools extension path is also not verified
  on DN's fork of the tooling.
- `dartpub.dev` currently requires free, open-source community plugins and
  lists contributor subscription discounts, not direct revenue sharing. A
  possible future author-payment scheme must not be treated as launched.

## Boundary decision

Build an opt-in **Dart runtime adapter** against the current Runtime Inspector
Protocol (RIP) **0.3** and the existing WebSocket broker. Do not alter RIP,
`panel-core`, the web panel, MCP, or the React Native SDK for the first slice.

```
DN animation parameters -> Dart opt-in SDK -> RIP 0.3 over WebSocket
                                            -> existing broker
                                            -> web panel / MCP
```

The Dart SDK owns registering one named schema, patching its declared values,
and firing explicitly registered actions. It owns **no panel UI** and **no new
broker**. The existing panel and broker remain the source of truth for message
semantics. Discrete animation configuration updates apply to **the next run**;
do not promise retargeting an already executing native/platform animation.

## Scope for first spike

1. An explicit `ws://` broker URL, one stable runtime client identity, a 0.3
   runtime handshake and schema publish/re-publish/dispose lifecycle.
2. One registered spring value (`damping`, `stiffness`, optional `mass`) with
   strict finite-number and positive-parameter validation; do not silently
   clamp. Optional sliders/triggers can follow the same binding semantics.
3. `control.patch`, `control.commit`, `control.batchPatch`, and
   `control.trigger` routed to registered callbacks, with unknown schema/control
   and invalid values rejected without mutating runtime state.
4. A tiny DN example that derives a `SpringDescription` from the most recent
   registered settings and replays one gesture/animation, if confirmed by DN's
   public API. Clearly mark it unverified until it runs on device.
5. Debug-only activation; ensure release paths do not connect to developer
   tooling. Make connection errors and reconnection behavior visible.
6. Dart tests for protocol fixtures/validation and runtime lifecycle; verify
   end-to-end with an actual DN app on iOS/Android before any publication.

## Non-goals

- No Babel transform or automatic widget/animation discovery.
- No write-back using the existing TS/JS source rewrite rules. Dart source
  anchors and analyzer-backed rewriting require a separate design and tests.
- No native overlay, Rozenite integration, timelines/recording, or spring
  reimplementation.
- No plugin publication, paid-plugin promise, or product rename in this spike.

## Questions for DN maintainers

1. Is there an official debug-only API to enumerate/tap `AnimationController`
   instances and observe native-backed animation lifecycle, rather than
   registering controls explicitly?
2. Which Dart VM service extensions and custom DevTools panels are supported
   in `dn run` and the officially supported IDE extension? Is `dart:io`
   WebSocket intended/supported on the main isolate during development on both
   iOS and Android?
3. Is `SpringDescription` part of DN's public `dartnative.dart` surface, and
   does changing the spring passed to a subsequent `fling` produce the same
   behavior on both platforms? What animated properties bypass this surface?
4. For developer-only packages, what is the supported packaging/activation
   pattern on the community marketplace? Are there upcoming introspection
   hooks or separate author-revenue terms?

## Promotion gate

Advance only after an actual DN app shows: live spring parameter edits from
the existing panel, a second gesture that visibly reflects them, a trigger
that replays the motion, clean hot reload/restart behavior, and no release
network connection. Until then, this is a compatibility experiment.
