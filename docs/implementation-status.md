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

### M5e editable timing duration

**Implemented on `feat/runtime-workbench-desktop`, covered by unit tests, pending manual validation on the Simulator**

Timing spans were read-only because their duration is a source literal with no control behind it. RFC 0005 §3b closes that gap without a new command message: a discovered literal becomes an ordinary control.

- The dev-only Babel plugin wraps the **config argument** of an eligible `withTiming(target, { duration: <number literal>, ... })` call with `__riAnimationConfig(...)`. Eligible means: object-literal config, no spread, exactly one literal `duration` between 0 and 10000 ms. Anything else is left exactly as in M5b.
- `__riAnimationConfig` registers one slider per call site in the existing `auto` schema and returns the original config object by identity until that slider is deliberately changed. It is a no-op in production and never throws into application code.
- `animation.started` carries an additive `parameterControls` reference (`duration` → `{ schemaId, controlId }`). `panel-core` resolves the live value through it, so the span's declared duration follows the control.
- The Workbench animation Inspector shows an editable **Duration** for such timing spans, and the span's right edge can be dragged on the timeline. Both go through the existing `setValue` / `commitValue` session path and replay the interaction on commit, like spring tuning. Out-of-range typed values are rejected with a reason, not clamped.
- `animation.started` / `animation.completed` are now documented in `docs/protocol.md` and covered by conformance fixtures, which the M5b spike had left out.

Known limits, recorded rather than hidden:

- the tuned duration applies on the **next** run of the call site; nothing is rewound;
- start offset is not editable: the example staggers its springs with `setTimeout`, which discovery cannot see;
- a timing span that is interrupted by a later animation on the same property (the example's springs start at ~220 ms, before the 260 ms timings end) is still drawn at its declared length;
- the control id embeds the call site's line and column, so inserting code above a call site and Fast Refreshing leaves the previous slider in the `auto` schema until a full reload;
- the timeline drag cannot extend a span past the right end of the visible timeline; the Inspector field can;
- the tuned duration is not written back to source. RFC 0004 anchors identify a `useSharedValue` declaration; a literal inside a call argument needs its own anchor shape.

Manual validation checklist:

1. Replay: four timing spans and four spring spans appear as before, and the app animates identically (no tuning yet).
2. The `Inspected values` schema gains four `… duration` sliders after the first Replay.
3. Select a timing span, set Duration to 600 ms, commit: the interaction replays and that span is drawn at 600 ms while the other three stay at 260 ms. In the example the return spring still takes over at ~220 ms, so the visible effect is that this property moves more slowly and travels less before springing back — not that the whole motion lasts longer.
4. Drag the right edge of another timing span (the grip sits at the span's end, on top of the overlapping spring): on release the interaction replays with the new duration.
5. Type 20000 in the Duration field: it is rejected with a reason and nothing is sent.
6. Set a duration back to 260 ms: the app behaves as in step 1.

### M6a timeline-first presentation

**Implemented on `feat/runtime-workbench-desktop`; checked in a browser against the demo runtime on 2026-10-02, pending validation with the real Simulator**

The timeline is the product surface, and it was unreadable: 8 px text, a timing and a spring span overlapping on one property row, and a toolbar of developer buttons. This milestone is presentation only — no protocol, `panel-core` or runtime change.

- One row per discovered animation (`Move X · Timing`, `Move X · Spring`), grouped under its element (`card`), with the duration on the left. Spans no longer overlap, so every resize handle is reachable.
- Neutral bars; the selected bar is accent-colored and its whole row is tinted. Selecting no longer moves the playhead, and scrubbing no longer changes the selection.
- Estimated spring ends fade out instead of using a dashed border.
- The playhead runs across the timeline while a replay plays, then rests at the end. It is a wall-clock indicator started when the first animation of the replay is reported; it does not rewind or seek the application.
- One primary **Play** button and a time readout. Record, Benchmark viewport and Clear moved into a **Developer** disclosure with unchanged behavior.
- The timeline region is taller (`minmax(300px, 44vh)`) and the stage no longer paints over it in short windows.

`pnpm --filter @runtime-inspector/workbench demo:runtime` starts a development-only fake runtime that publishes the example's `card-transition` and `auto` schemas and emits the same eight animation events on Replay. It exists so the Workbench UI can be developed and screenshotted in a browser without a Simulator; it is not a product feature and holds no control state.

### M6b arrangeable timeline and the recording demo

**Implemented on `feat/runtime-workbench-desktop`; exercised in a browser against the demo runtime on 2026-10-02 (move, left-edge and right-edge resize, field edits, replay). Not yet validated with the real Simulator.**

RFC 0005 §3c, same rule as §3b — a source literal becomes an ordinary control, no new command:

- Discovery now also covers `shared.value = withDelay(<delay>, withTiming|withSpring(...))`. A numeric-literal delay becomes a slider; a non-literal delay is only observed.
- A bare `withTiming` / `withSpring` in a module that imports Reanimated gets a start control defaulting to 0. At 0 the original animation object is returned untouched; above 0 it is wrapped with the module's own `withDelay`.
- Spring configs written as object literals get sliders for `damping`, `stiffness` and `mass`.
- `animation.started` carries additive `startControl` and `startDelayMs`. `startedAtRuntimeMs` is now the expected start of motion (call time plus applied delay), and the timeline origin is the earliest **call** time, so delaying the first animation does not shift every other row.
- Workbench: a block can be dragged to move its start, resized from either edge (the left edge keeps the end fixed), and every backed parameter is an editable field in the Inspector. Each change goes through `setValue` / `commitValue` and replays the interaction.
- The timeline shows the latest interaction across all schemas, grouped by element (`titleY` → group `title`, row `Y`). **Play** fires the first `replay` trigger found in any schema.
- The Outline of raw controls is hidden by default behind a **Controls** toggle in the top bar.
- The example app's default screen is now `ProductRevealDemo`: a staggered entrance written as plain Reanimated code (`useSharedValue`, `withDelay`, `withTiming`, `withSpring`, one `useAction("replay")`), with no Runtime Inspector declarations beyond that trigger. The previous test card moved to `CardTransitionLab` (`SCREEN = "lab"` in `App.tsx`; the viewport benchmark needs it).
- The demo runtime imitates `ProductRevealDemo` and keeps the current value of every slider, so the whole edit → replay loop can be exercised without a Simulator.

Manual validation checklist (Simulator):

1. The new screen appears and its entrance plays on launch and on **Play album**.
2. Workbench **Play**: eight rows in four groups (cover, title, details, button), starts at 0 / 140 / 240 / 380 ms.
3. Drag the `title · Y` block to the right and release: the app replays and the title visibly enters later. Drag it back: original rhythm.
4. Drag the `cover · Opacity` block (a bare call, delay 0) to the right: the cover fades in later.
5. Select `cover · Scale`, raise Damping, commit: the spring settles with less bounce.
6. With nothing tuned, the entrance is indistinguishable from the un-instrumented app.

Known limits:

- a start cannot be moved before the call itself, and stagger produced by `setTimeout` or state is invisible;
- `withSequence` / `withRepeat`, completion callbacks and gesture-driven motion are not discovered;
- tuned values are not written back to source (RFC 0004 gap);
- spring span ends are still estimates;
- the `spring`-control path (`configControlId`) still resolves its control in the Outline-selected schema.

### M6c Workbench chrome: one header, DialKit controls, themes

**Implemented on `feat/runtime-workbench-desktop`; checked in a browser against the demo runtime on 2026-10-02 (both themes, DialKit slider commit → replay). The unified title bar is Electron-only and was not visible in that check.**

- The window uses `titleBarStyle: "hiddenInset"`. The former top bar and the stage toolbar are one 44 px header that is also the drag region: brand, Controls toggle, notice, live capture status, simulator select, input status, attach/detach, theme toggle, connection. In a browser the same header renders without the traffic-light inset.
- The Workbench no longer hand-rolls editors. Both inspectors render `InspectorControlRow` from `packages/panel-dialkit` inside a minimal `dialkit-root` scope (`DialKitScope`), so sliders, springs, Béziers, colors, toggles, exact entry and reject-don't-clamp behave exactly as in the web panel. For a selected animation the session passed to the rows is an adapter whose `commitValue` also replays the interaction.
- Light and dark themes with an Auto / Light / Dark toggle (persisted in `localStorage`, Auto follows `prefers-color-scheme`). Every color in `styles.css` is a `--wb-*` token; the resolved theme is also passed to DialKit. The simulated-device placeholder stays dark in both themes.
- The playhead time pill is always centered on its line.
- The timeline region is a DialKit surface too: it sits in a `dialkit-root` scope, uses DialKit's own timeline classes where their CSS fits a percentage-based layout (`dialkit-timeline-row`, `-label`, `-lane`, `-ruler`, `-tick*`, `-group-toggle`, `-clip`, `-time`) and `--dial-*` tokens everywhere else. DialKit's real `DialTimeline` dock was evaluated from its 2.0.2 source and rejected as the main timeline: it is a fixed body-level portal with no inline mode, it owns and quantizes timing in its own store (50 ms minimum, 10 ms steps, values preserved across config changes), it has no drag-end event or per-clip constraints, a marker clip cannot be selected, and its Play cannot be told apart from a scrub release. Selection follows DialKit's convention (a ring on the clip) plus a row tint.

### M6d one design system

**Implemented on `feat/runtime-workbench-desktop`; both themes checked in a browser on 2026-10-02, including a computed-style census of every visible text node.**

Header, Outline, Inspector chrome, stage chrome and timeline now share one language, enforced by greps over `packages/workbench/src/styles.css`:

- Typography is DialKit's: `system-ui` plus `Geist Mono` for numerals, and only these steps — title 13/600, body 13/500, small 11/500, label 11/600, mono 11/500, micro 10/500 (ruler ticks and playhead flag), display 20/600 (device placeholder title only). Every rule uses a `--wb-type-*` token; `font-size`, `font-weight` and `font-family` do not appear outside the token block. No uppercase transforms, no letter-spacing.
- Neutrals are DialKit's values in every region: one surface, three text levels, one border.
- One radius (8 px, 5 px for timeline bars) and one control height (28 px).
- Three button variants (`.wb-button.primary | .secondary | .toggle`) and one status pill (`.wb-pill`).
- One accent hue, used only for primary buttons (Play, attach), pressed toggles, the selected timeline bar and its row tint, the playhead, and focus rings. Green remains only as a status dot.

### M6e hierarchy pass

**Implemented on `feat/runtime-workbench-desktop`; both themes checked in a browser against the demo runtime on 2026-10-02. Not yet seen with a real Simulator frame in the stage.**

A design review found every element carrying the same visual weight. Within the M6d system:

- **Accent** is `#F5430F` (one hue, same five uses).
- **The device is the subject.** The timeline height is a `--wb-timeline-h` variable (default `clamp(240px, 36vh, 520px)`), resizable by dragging the seam (`role="separator"`, keyboard arrows, double-click to reset, persisted in `localStorage`). The simulator surface uses the full stage height minus 16 px padding. The seam is a single subtle line with a grip that appears on hover.
- **Header.** Capture diagnostics (resolution, fps, encode/decode, frame source) moved to the Developer menu and to the `title` of a small `Live` / `View only` pill. Connection and input state are the emphasized pills.
- **Inspector.** The name appears once: `Cover · Scale`, then one summary line (`Spring · starts 0ms · ~986ms → 1`). The playhead-state badge and the Starts / Duration / At playhead / Target rows are gone. Springs written with literal parameters show DialKit's spring curve (`SpringPreview`, exported by `panel-dialkit`) above their sliders. Source is one `file:line` with the expression behind a `Code` disclosure. A control selected from the Outline shows its label once and a `Value` row.
- **Timeline bars are told apart by shape.** A delayed animation shows a dashed lead-in from its call time to the bar; springs carry a slight accent tint and the fade-out tail; timings are solid neutral; only the selected bar is accent-filled.

- **No pop on attach.** The stage shows one persistent phone-shaped device frame (`.device-frame` bezel around `.device-frame-screen`) in every desktop state. Attaching used to swap the placeholder for a different element that had no aspect ratio until the first frame was decoded, which produced a shape jump and a black flash. Now the frame keeps its geometry, the capture dimensions come from the bootstrap frame at attach time, and the live canvas fades in over 180 ms. Simulator pointer handlers sit on the screen element, not the bezel, so input mapping is unchanged. Geometry was checked in a browser; the attach itself can only be validated in the desktop app.

- **Real device bezel.** In the desktop app the frame is the selected iPhone's own bezel, read at runtime from the local Xcode installation (`/Library/Developer/CoreSimulator/Profiles/DeviceTypes/*.simdevicetype` → `chromeIdentifier` → `/Library/Developer/DeviceKit/Chrome/*.devicechrome`), rasterized with `sips` into the app's user-data cache and drawn as a 9-slice `border-image`; the screen is clipped with the device's `framebufferMask`. Nothing from Xcode is copied into the repository. Any failure (unknown model, moved folders, `sips`/`plutil` error) falls back to the generic frame with one warning and never blocks attach. This is private Xcode layout and must be re-checked per Xcode release, like the IndigoHID input path. No Dynamic Island overlay or hardware buttons yet. Verified through a standalone preview of the iPhone 17 Pro Max bezel; not yet seen inside the Electron window by the author of this note.

### M6f a timeline that holds still

**Implemented on `feat/runtime-workbench-desktop`; measured in a browser against the demo runtime on 2026-10-02.**

Owner feedback: moving a block re-sorted and redrew the whole timeline, so the sense of what was being touched was lost.

- **Order is source order.** Groups and rows follow `(file, line, column)` of their call sites (input order when a source is missing). Start time no longer affects order.
- **Rows keep their identity across replays.** Rows are keyed by call site, not by animation instance. Because `animation.started` messages arrive one at a time, the newest burst is merged into the displayed one (`mergeBurst`, stale rows rebased to the new time origin) and rows that did not come back are removed only after a 150 ms settle.
- **The released value is an optimistic preview** kept until the new instance arrives (or 2 s pass), so a bar no longer slides back and then forward.
- **The time scale is sticky.** While the same set of call sites is on screen the ruler only grows; double-clicking the ruler refits it.
- Bars, lead-ins and handles transition between replays (not during a live gesture); the group chevron rotates when a group opens or closes.

Measured with a `MutationObserver` over a drag-commit-replay cycle: 8 rows before, the same 8 DOM nodes after, 0 rows added or removed, row count never below 8, selection kept on the edited row, tick labels unchanged, row order unchanged after moving a block from 140 ms to 873 ms.

Not done yet:

1. scrubbing the playhead with the stage following it (needs recorded frames or opt-in seeking; RFC 0005 decision 5 currently says video is live only);
2. before/after comparison of two replays;
3. reworking the Inspector around the selected animation.

