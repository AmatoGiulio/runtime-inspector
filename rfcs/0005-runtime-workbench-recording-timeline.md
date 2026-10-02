# RFC 0005 — Runtime Workbench: recording, probes and motion timeline

- Status: proposed; M0 validated on macOS 2026-10-01; M3a live iOS Simulator viewport spike implemented on `feat/runtime-workbench-ios-viewport`
- Author: Giulio Amato / architect session, 2026-10-01
- Base: `rozenite-client`
- Affects: `protocol` (additive), `runtime-react-native`, `panel-core`, `transport-ws`, `cli`, new desktop Workbench client, docs
- Breaking: no — the protocol additions are additive and unknown messages remain ignorable
- Product scope: React Native + Reanimated, macOS, iOS Simulator + Android Emulator

## Summary

Runtime Inspector evolves from a live tuning panel into a **runtime motion workbench**.

The center of the product is the real running application — captured from the iOS Simulator or Android Emulator — surrounded by runtime-aware tooling:

```text
┌──────────────┬─────────────────────────────┬──────────────┐
│ OUTLINE      │                             │ INSPECTOR    │
│              │       LIVE RUNTIME          │              │
│ Controls     │   iOS Simulator / Android   │ value        │
│ Probes       │          Emulator           │ spring       │
│ Events       │                             │ bezier       │
│              │                             │ material     │
├──────────────┴─────────────────────────────┴──────────────┤
│ ● REC   ▶ REPLAY                                          │
├──────────────┬────────────────────────────────────────────┤
│ translateX   │ ─────╭────────────────────                 │
│ velocityX    │ ───╭──╮                                   │
│ scale        │ ──────╭────────╮                           │
│ spring       │ ─────────╭─╮╭──                            │
│ events       │     ◆             ◆                        │
└──────────────┴────────────────────────────────────────────┘
```

The Workbench does **not** reconstruct the application in a design canvas. It observes and tunes the real runtime.

## Product thesis

Existing tools usually own only one part of the loop:

- design/prototyping tools author motion but do not run the production app;
- profilers observe the production app but do not author/tune its motion;
- device mirroring tools show/control the device but know nothing about application semantics;
- Runtime Inspector already tunes semantic runtime values and writes them back to source.

The Workbench joins these pieces:

```text
REAL RUNTIME
    +
EXPLICIT RUNTIME SEMANTICS
    +
MOTION TIMELINE
    +
LIVE TUNING
    +
SOURCE WRITE-BACK
```

## Decisions

### 1. The Workbench is a separate desktop client

Rozenite remains an excellent React Native DevTools client, but it is not the container for the full Workbench.

The desktop Workbench needs OS-level capabilities that a DevTools iframe should not own:

- capture another application/window;
- start/stop Simulator/ADB helpers;
- forward pointer input;
- request macOS Screen Recording / Accessibility permissions;
- manage local recording files later.

The Workbench is another RIP `panel` client and reuses `panel-core`. It must not duplicate schema state, patch/commit semantics, A/B comparison, export or stale handling.

### 2. The center viewport is the real runtime

No React/HTML recreation of the app.

V1 device adapters:

- **iOS Simulator**: live window capture on macOS; pointer forwarding is a V1 target.
- **Android Emulator**: scrcpy/ADB-based video + control path.

The viewport transport is local Workbench infrastructure, **not RIP**. RIP carries application semantics; the device adapter carries pixels/input.

### 3. Recording is explicit instrumentation, not magic introspection

V1 does not promise automatic discovery of every animation in an arbitrary React Native app.

The runtime exposes two new concepts:

- **probe** — a value worth observing over time;
- **event** — a discrete moment worth marking on the timeline.

Example target API:

```ts
useRuntimeProbe("card.translateX", translateX, { unit: "px" });
useRuntimeProbe("gesture.velocityX", velocityX, { unit: "px/s" });

const markRelease = useRuntimeEvent("gesture.release");

// gesture end
markRelease();
```

Controls remain editable. Probes are observational by default.

### 3a. Experimental automatic Reanimated primitive discovery

The original V1 decision above remains the safe baseline: explicit probes are the guaranteed instrumentation path. The Workbench now carries an **experimental spike** to test whether a useful subset of Reanimated motion can appear automatically.

In development builds, the existing Babel plugin recognizes direct assignments of these forms:

```ts
shared.value = withTiming(target, config);
shared.value = withSpring(target, config);
```

and wraps them with Runtime Inspector development helpers. The emitted lifecycle carries:

- animation kind (`timing` / `spring`);
- target expression;
- runtime start/end timestamps;
- serializable primitive target/current values;
- selected timing/spring parameters;
- source file, line, column, enclosure, and original animation expression;
- schema id when the assignment target can be associated with a local `useInspector("schema-id", ...)` handle or an auto-inspected shared value.

The first spike deliberately does **not** instrument:

- animation calls with an explicit completion callback, until callback composition is proven not to interfere with Reanimated workletization;
- nested modifier trees such as `withDelay`, `withSequence`, or `withRepeat`;
- gesture-following direct shared-value writes;
- arbitrary custom animation functions.

This is a product-feasibility experiment, not yet a replacement for explicit probes. If the runtime test succeeds without changing animation behavior, V1 can promote the narrower promise **automatic discovery of supported Reanimated animation primitives** while keeping explicit probes as the escape hatch.

### 4. V1 timeline is observational

The playhead inspects a recorded trace.

It does **not** universally force the application back to an arbitrary historical state.

V1 supports:

- record;
- live graphing;
- event markers;
- playhead inspection;
- replay via existing explicit `trigger` controls;
- A/B parameter comparison;
- live tuning;
- Apply to code.

Universal time travel / arbitrary runtime rewind is explicitly deferred.

### 5. Video is live, not timeline-synchronized in V1

The central device viewport remains live while signals are recorded.

V1 does not promise frame-accurate synchronization between captured video frames and runtime probe samples. Avoiding this requirement removes a second clock domain and keeps the first release realistic.

A later RFC may add timestamped viewport recording.

## Runtime data model

### Probe descriptor

V1 starts intentionally narrow:

```ts
type ProbeDescriptor = {
  id: string;
  label?: string;
  group?: string;
  valueType: "number" | "boolean";
  unit?: string;
};
```

Numeric probes become graphs. Boolean probes become stepped tracks.

Vector/color/structured probes are deferred until a real use case requires them.

### Event descriptor

```ts
type RuntimeEventDescriptor = {
  id: string;
  label?: string;
  group?: string;
};
```

Events render as timeline markers.

### Recording

A recording is owned by the Workbench after capture:

```ts
type Recording = {
  id: string;
  startedAtRuntimeMs: number;
  durationMs: number;
  sampleRateHz: number;
  probes: ProbeDescriptor[];
  events: RuntimeEventDescriptor[];
  chunks: RecordingChunk[];
  complete: boolean;
};
```

All trace timestamps use one monotonic runtime clock.

## Proposed RIP additions

Names are provisional until implementation review, but semantics are fixed by this RFC.

### `trace.schema.publish` — State

Runtime → panels.

Publishes available probe/event descriptors for a runtime schema.

- idempotent;
- last value may be cached/replayed;
- disposed when the owning runtime schema disappears.

### `trace.schema.dispose` — Lifecycle event

Runtime → panels.

Removes a trace schema.

### `recording.start` — Command

Panel → runtime.

```json
{
  "type": "recording.start",
  "recordingId": "rec-123",
  "schemaId": "card-transition",
  "probeIds": ["card.translateX", "gesture.velocityX"],
  "sampleRateHz": 60
}
```

Never cached or replayed.

Runtime rejects unsupported rate/count combinations explicitly.

### `recording.started` — Lifecycle event

Runtime → panel.

Confirms the selected probes and establishes the runtime monotonic start timestamp.

### `recording.chunk` — Lifecycle event

Runtime → panel.

Carries ordered, bounded batches of samples/events while recording.

Chunks are:

- sequence-numbered;
- never broker-cached;
- never replayed after reconnect;
- considered incomplete if a sequence gap occurs.

The Workbench can draw the timeline incrementally as chunks arrive.

### `recording.stop` — Command

Panel → runtime.

Stops capture and flushes the final chunk.

### `recording.complete` — Lifecycle event

Runtime → panel.

Contains duration, sample count and completion metadata.

If transport disconnects before completion, the Workbench keeps the partial trace but marks it incomplete.

## Sampling strategy

Sampling must not turn the debugger into the performance problem it is measuring.

V1 constraints:

- default: **60 Hz**;
- initial hard cap: **16 simultaneously active numeric/boolean probes**;
- initial recording duration target: **10 seconds**;
- samples collected on the Reanimated/UI execution path where possible;
- samples transferred to JS/transport in batches, not one message per frame;
- no React re-render per sample.

The exact Reanimated implementation is an implementation spike. The likely adapter uses frame callbacks/worklets to collect selected SharedValues and periodically flush bounded batches across the thread boundary.

If the adapter cannot meet the budget without materially affecting frame time, the recorder does not ship until that is solved.

## Workbench architecture

```text
                         ┌──────────────────────────┐
                         │     Desktop Workbench    │
                         │                          │
                         │  Outline   Inspector     │
                         │       Timeline           │
                         └───────┬─────────┬────────┘
                                 │         │
                           RIP / WS         │ local IPC
                                 │         │
                 ┌───────────────┘         └───────────────┐
                 ▼                                         ▼
        WebSocket broker                           Device Adapter
                 │                                  ├ iOS Simulator
                 ▼                                  └ Android Emulator
        React Native runtime
                 │
          Reanimated adapter
                 │
          probes / controls
```

Existing paths remain valid:

```text
Rozenite panel ────────> RIP runtime
Web panel ── broker ──> RIP runtime
MCP agent ── broker ──> RIP runtime
Workbench ── broker ──> RIP runtime
```

The Workbench is additive, not a replacement for the other clients.

## Device viewport adapters

### iOS Simulator

V1 target:

- enumerate Simulator windows/devices;
- capture the selected Simulator viewport;
- display it inside the Workbench;
- map Workbench pointer coordinates to Simulator coordinates;
- forward tap/drag input after explicit macOS permission.

Expected OS requirements:

- Screen Recording permission for capture;
- Accessibility permission if synthetic pointer forwarding uses macOS event injection.

Fallback during the first implementation milestone: capture is embedded but interaction remains on the actual Simulator window.

Reference: [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit).

### Android Emulator

Use the existing scrcpy/ADB ecosystem instead of inventing a mirroring protocol.

The adapter owns:

- device selection;
- video stream;
- coordinate transform;
- pointer/key forwarding.

Reference: [Genymobile scrcpy](https://github.com/Genymobile/scrcpy).

The Workbench should consume the scrcpy server/control protocol or another embeddable path; embedding scrcpy's SDL window is not the architecture.

## Workbench UI responsibilities

### Outline

Shows semantic runtime data, not a fake layer tree:

```text
Card transition

Controls
  damping
  stiffness
  blur

Probes
  translateX
  velocityX
  scale

Events
  touchDown
  release
  settled
```

### Inspector

Contextual editor for the selected item:

- control value;
- spring curve + damping/stiffness/mass;
- Bézier;
- range/unit metadata;
- current playhead value for a probe;
- Apply to code when a source anchor exists.

### Timeline

V1 track types:

- continuous numeric graph;
- stepped boolean graph;
- event marker.

Required interactions:

- record/stop;
- horizontal zoom;
- pan;
- playhead;
- select track;
- hover exact sample;
- show min/max/current;
- replay trigger.

Keyframes are not the primary model. Runtime signals and events are.

## Replay semantics

Replay is intentionally explicit.

A runtime can expose:

```ts
const replay = useAction("replay", () => runTransition());
```

The Workbench invokes the existing `control.trigger`.

This gives deterministic-enough repeated experiments without claiming arbitrary app-state reconstruction.

Future replay work may define snapshots/preconditions, but it is not part of V1.

## Source write-back

No new source-write mechanism is needed.

Existing RFC 0004 remains authoritative:

```text
tune live
→ compare
→ choose values
→ Apply to code
```

Recorded probes are not automatically writable. Only controls with valid source anchors can be written back.

## Explicit non-goals for V1

- arbitrary time travel / rewind;
- automatic discovery of all Reanimated animations;
- React component tree animation inference;
- frame-accurate video + trace synchronization;
- remote control of a physical iPhone;
- physical-device viewport support;
- UIKit / SwiftUI / Compose generic instrumentation;
- Windows/Linux Workbench;
- 120 Hz guaranteed recording;
- generic plugin system;
- timeline-based keyframe authoring;
- replacement for Instruments, Android Studio Profiler or React Native DevTools.

## Milestones

### M0 — vertical spike

One hardcoded Reanimated SharedValue:

```text
real app
→ 60 Hz samples
→ broker
→ desktop graph
```

Success criterion: a 10 s trace does not create visible animation degradation in the example app.

### M1 — protocol + recorder

- RFC message schemas;
- conformance fixtures;
- explicit probe/event APIs;
- recording start/chunk/stop/complete;
- sequence-gap handling;
- unit tests.

No desktop polish.

### M2 — Workbench shell

Implement the four-region layout:

```text
Outline | Live Runtime | Inspector
        |   Timeline
```

Reuse `panel-core` for all existing control semantics.

### M3 — iOS Simulator viewport

- live embedded capture;
- simulator selection;
- coordinate mapping;
- input-forwarding spike;
- permission UX.

### M4 — Android Emulator viewport

- scrcpy/ADB adapter;
- embedded stream;
- pointer forwarding;
- device selection.

### M5 — timeline UX

- incremental graph drawing;
- markers;
- zoom/pan/playhead;
- current-value inspection;
- replay;
- recording export format for bug reports / later comparison.

### M6 — integration

- spring/Bézier control selection;
- A/B workflow;
- Apply to code;
- stale/reload recovery;
- performance pass.

## Acceptance criteria for V1

V1 is successful when a developer can:

1. launch the example React Native app;
2. open Runtime Workbench;
3. see the running iOS Simulator or Android Emulator in the center;
4. interact with the app;
5. record declared runtime probes and events;
6. immediately see their real curves in the timeline;
7. select a spring/control and tune it live;
8. replay the same explicit interaction/transition;
9. compare two parameter sets;
10. write the chosen value back to source.

Nothing in this list requires universal time travel or reconstruction of arbitrary application state.

## Open implementation questions

These are spikes, not product-level uncertainty:

1. Desktop shell: Electron 44 is selected for the M3b implementation spike because it preserves the existing Vite/React Workbench and exposes desktop capture; this is not yet a permanent packaging commitment.
2. Best low-copy path from iOS window capture into the Workbench renderer.
3. Best embeddable scrcpy decoding path for Electron/Tauri.
4. Reanimated sampling implementation and measurable overhead.
5. Whether Workbench needs a dedicated local IPC process or the CLI can host device adapters.

The RFC should not choose these based on aesthetics. M0/M2/M3 measurements decide them.

## Prior art / references

- [Runtime Inspector — current branch](https://github.com/AmatoGiulio/runtime-inspector/tree/rozenite-client)
- [Rozenite](https://github.com/callstackincubator/rozenite)
- [scrcpy](https://github.com/Genymobile/scrcpy)
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Android Studio Compose Animation Preview](https://developer.android.com/develop/ui/compose/tooling/animation-preview)
- [React Native Reanimated](https://docs.swmansion.com/react-native-reanimated/)
- [Fluid Interfaces](https://github.com/nathangitter/fluid-interfaces)

## Deferred follow-up RFCs

If V1 validates the product, separate RFCs may cover:

- timestamped viewport recording;
- runtime state snapshots / opt-in scrubbing;
- 120 Hz/native trace transport;
- physical-device viewport support;
- derived probes (velocity/acceleration computed by the Workbench);
- motion diff / overlaid A/B traces;
- agent-driven record → tune → replay → compare loops.