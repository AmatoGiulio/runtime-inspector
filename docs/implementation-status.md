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

**M3b.2 native HID path validated manually on macOS, 2026-10-01; crop alignment refinement pending**

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

**M3c.0 validated manually on macOS, 2026-10-01**

- exact iOS framebuffer frames from `simctl io screenshot`, pushed over Electron IPC;
- no Simulator-window crop or coordinate mapping;
- native HID input validated from the embedded viewport;
- observed cadence ~9 fps on the validation run, confirming the screenshot-per-frame transport is far too slow for product use.

**M3c.1 cold-start validated manually on macOS, 2026-10-01; persistent MJPEG path performance characterized**

- persistent native CoreSimulator helper;
- direct main-display IOSurface access;
- one-shot `simctl io screenshot` startup prime;
- bootstrap frame deferred until the React framebuffer canvas is mounted, avoiding the first-frame IPC race;
- 60 Hz seed polling with surface-swap refresh;
- pre-encode downscale using the shared runtime framebuffer profile;
- framed JPEG transport over one long-lived process;
- coalesced canvas decoding in the renderer;
- per-frame capture timestamp + native encode timing;
- rolling motion FPS, capture-to-canvas latency, encode cost, and decode/draw cost visible in the Workbench;
- HID stays on the same normalized framebuffer coordinate system.

**Still outstanding**

- keep the validated SimScreen callback path covered across supported Xcode versions;
- revisit VideoToolbox H.264 only if future CPU/bandwidth targets require it;
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

### M3c.2 deterministic encoder tuning

**Implemented and benchmarked locally on `feat/runtime-workbench-desktop`, 2026-10-01**

- native benchmark mode reuses the production IOSurface JPEG encoder;
- deterministic 1320×2868 synthetic source surface;
- baseline/balanced/fast/lean profiles;
- repeated rounds with p50/p95/payload metrics;
- same-run relative performance gate;
- deterministic PSNR quality comparison at a common 600 px reference size;
- shared profile configuration used by both runtime and benchmark;
- official runtime profile promoted to `balanced` (560 px, JPEG quality 0.60);
- official balanced gate: p95 <= 90% of baseline, payload <= 85% of baseline, PSNR loss <= 1.10 dB;
- CI-safe regression tests verify the official profile/gate and deterministic workload/output properties without asserting hardware-dependent milliseconds.

Observed local deterministic sweep on the M4 Pro test host:

| profile | p95 encode | p95 capacity | avg payload | PSNR | delta vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline 600/0.65 | 16.29 ms | 61.4 fps | 513.5 KB | 19.41 dB | — |
| balanced 560/0.60 | 14.01 ms | 71.4 fps | 400.7 KB | 18.41 dB | -0.99 dB |
| fast 520/0.58 | 12.79 ms | 78.2 fps | 340.5 KB | 17.88 dB | -1.52 dB |
| lean 480/0.55 | 11.64 ms | 85.9 fps | 277.1 KB | 17.31 dB | -2.10 dB |

Commands:

~~~bash
pnpm benchmark:framebuffer
pnpm benchmark:framebuffer:gate
~~~

### M3c.3 deterministic live viewport benchmark

**Implemented and manually validated on `feat/runtime-workbench-desktop`, 2026-10-01**

The example runtime now exposes a dedicated viewport benchmark trigger. It drives the card through a fixed 24-repetition, 140 ms linear back-and-forth animation so the framebuffer transport sees sustained, repeatable motion rather than manual Replay clicks.

The Workbench adds **Benchmark viewport**. A run:

- resets a dedicated measurement window;
- fires the benchmark trigger exactly once;
- samples the persistent framebuffer for 3.6 seconds;
- reports sustained FPS, frame-interval p95, encode p95, decode p95, latency p95, and received frame count.

This is separate from the normal rolling toolbar statistics and is the repeatable live-transport validation for the promoted framebuffer profile. It measures framebuffer capture-to-canvas behavior; it is not a HID-input-to-visual-response measurement.

### M3c.4 high-frequency IOSurface seed polling

**Implemented and manually validated on `feat/runtime-workbench-desktop`, 2026-10-01**

The first deterministic live viewport benchmark with the balanced profile measured:

- 54.4 fps sustained;
- 19.0 ms frame-interval p95;
- 10.5 ms native JPEG encode p95;
- 2.1 ms decode/draw p95;
- 12 ms capture-to-canvas latency p95.

Because encode and decode are both comfortably below a 16.67 ms frame budget, the next experiment keeps the high-quality `balanced` stream unchanged at 560 px / JPEG 0.60 and changes only frame detection.

The persistent helper now decouples:

- **seed polling** — every 500 µs;
- **encoding/output** — capped at the requested 60 fps and only when `IOSurfaceGetSeed` reports a changed framebuffer.

Previously the helper checked the IOSurface only once per ~16.67 ms encode cadence. That can alias against Simulator presentation timing and miss a fresh frame until the next polling cycle. The new path detects presents at much finer granularity without encoding unchanged frames or increasing JPEG quality loss.

Manual validation after decoupling seed polling from encode cadence measured **58.7 fps**, frame-interval p95 **18.0 ms**, encode p95 **10.4 ms**, decode/draw p95 **2.0 ms**, and capture-to-canvas latency p95 **12 ms**. This confirmed that JPEG quality was not the limiting factor and justified moving frame detection to `SimScreen` callbacks.

### M3c.5 SimScreen present callbacks

**Implemented and manually validated on `feat/runtime-workbench-desktop`, 2026-10-01**

The high-frequency seed-polling experiment raised the deterministic live viewport result from 54.4 fps to 58.7 fps while leaving encode/decode/latency essentially unchanged. That confirms the remaining loss is in frame detection rather than JPEG quality.

The persistent native helper now prefers CoreSimulator's new-style `SimScreen` callback API:

- `registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:`;
- the callback itself stays minimal and only signals the encoder worker;
- multiple presents that arrive while JPEG encoding are coalesced;
- `surfacesChangedCallback` requests a safe main-thread/single-worker surface reacquire;
- JPEG encoding remains off the CoreSimulator callback queue;
- stream quality remains unchanged at the promoted `balanced` profile: 560 px / JPEG 0.60;
- the 500 µs IOSurface seed poller remains as the compatibility fallback when `SimScreen` registration is unavailable or raises.

The native helper prints one startup status line:

~~~text
[Runtime Inspector] frame-source=simscreen-callbacks
~~~

or, on compatibility fallback:

~~~text
[Runtime Inspector] frame-source=seed-polling fallback=...
~~~

Manual validation with callback mode active produced:

~~~text
60.4 fps · frame p95 19.3 ms · enc p95 11.5 · dec p95 2.0 · lat p95 13 ms · 215 frames
~~~

The comparison baseline was the validated high-frequency polling result:

~~~text
58.7 fps · frame p95 18.0 ms · enc p95 10.4 · dec p95 2.0 · lat p95 12 ms
~~~

The callback path therefore reached the 60 fps target while preserving the promoted `balanced` quality profile. The Workbench now also surfaces the active native frame source in the Runtime toolbar (`SimScreen callbacks` or `seed polling`) instead of requiring terminal inspection.

### M5a semantic Outline + contextual control Inspector

**Implemented on `feat/runtime-workbench-desktop`, pending manual UI validation**

With the iOS viewport transport now stable at ~60 fps, the Workbench begins the product-facing semantic workflow rather than further framebuffer tuning.

The left Outline now merges the existing RIP control schema and trace schema for each runtime surface:

- **Controls** — slider, toggle, color, spring, Bézier and trigger controls;
- **Probes** — declared runtime trace signals.

Selecting a control opens a contextual Inspector backed by the existing `panel-core` session semantics:

- slider preview patches remain throttled by `panel-core`, followed by an explicit commit;
- toggle/color/spring/Bézier values use the same validated RIP patch/commit path as the existing clients;
- trigger controls call the existing at-most-once `control.trigger` flow;
- controls with source anchors expose **Apply to code** through the existing RFC 0004 write-back path;
- stale runtime schemas render their controls disabled rather than inventing a second stale-state model.

Selecting a probe keeps the existing observational Inspector and timeline behavior. The timeline continues to follow the most recently selected probe even while a control is being tuned, so a developer can tune a parameter while watching the relevant runtime trace.

No new RIP messages were introduced.

### M5b experimental automatic Reanimated discovery

**Validated manually on the iOS Simulator on 2026-10-02**

The product-critical spike now proves that common Reanimated primitives can appear in the Workbench without one manual probe declaration per animation.

The dev-only Babel plugin recognizes direct `.value = withTiming(...)` and `.value = withSpring(...)` assignments with no explicit completion callback. The application still constructs its original Reanimated animation object first; Runtime Inspector then observes and returns that exact object unchanged. This behavior-transparent form was manually validated: Replay animates normally, the Workbench receives the discovered rows, and the Expo app remains stable.

The discovery event carries the assignment target, source location, owning `useInspector` schema when statically known, primitive target literals, safe literal config fields (for example `duration: 260`), and a control reference for dynamic config objects such as `card.spring.value`.

`panel-core` resolves dynamic config references against the current inspector state. Timing spans use their declared duration. Spring spans use the existing spring response model to derive an explicitly estimated settling span; this is presentation metadata, not a claim that an actual completion event was observed.

The Workbench groups the newest start events into a derived **latest interaction burst** and renders those expected spans. Exact runtime completion remains intentionally unsolved without a behavior-transparent completion signal.

Still intentionally unsupported by this proof:

- nested modifier trees such as `withDelay`, `withSequence`, or `withRepeat`;
- calls with an explicit completion callback;
- assignments inside known UI-runtime/worklet callbacks (skipped rather than risking app behavior);
- arbitrary custom animation functions.

Validated example result: the four direct timing animations and four return springs in `replayTransition()` are discovered automatically, without using the manual probe declaration for those lifecycle rows.

The Workbench presentation now collapses lifecycle instances by runtime property: `card.moveX`, `card.rotate`, `card.scale`, and `card.opacity` each render as one property track containing their timing and spring spans on the same temporal axis. This is the first transition from an event-log presentation toward the timeline-first product model.

### M5c timeline-first interaction surface

**Implemented on `feat/runtime-workbench-desktop`, pending manual UX validation**

The Workbench timeline now has a temporal ruler and draggable observational playhead. Auto-detected animation spans render on property rows against that shared time axis, remain selectable, and drive a contextual animation Inspector.

Selecting a timing span exposes its start, declared duration, target metadata, parameters, source location, and original source expression. Selecting a spring span exposes the same temporal/source context plus live spring tuning when its dynamic config resolves back to an Inspector spring control. Spring settle duration remains explicitly marked as estimated.

The playhead is observational only: dragging it answers what is active at that time in the Inspector but does not rewind the running application.

The old single-probe graph is no longer rendered as the primary timeline body. Probe recording remains available in the protocol and contextual Inspector while the main Workbench surface moves to the property/span time model.

### M5d timeline inspection UX refinement

**Implemented on `feat/runtime-workbench-desktop`, pending manual validation**

The motion timeline now renders one global playhead across the ruler and all property tracks instead of repeating a marker per row. The ruler uses a denser scale for short interactions (the validated ~1.2 second replay resolves at 200 ms intervals), and dragging directly on a property track selects the animation span active at that instant. When timing and spring overlap, the most recently started span wins.

The spring animation Inspector now has one editable parameter section instead of duplicating read-only and editable spring values. Committing damping/stiffness/mass automatically replays the interaction and keeps focus on the corresponding spring span from the new replay.

The earlier broker routing regression is also fixed: schema-scoped panel commands are delivered only to the runtime WebSocket that published that schema, preventing one Replay from firing once per active runtime schema.

