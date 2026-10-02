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
