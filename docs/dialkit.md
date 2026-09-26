# DialKit rendering

Both the web panel and the Rozenite DevTools panel render through `packages/panel-dialkit`. It uses the controlled React components from DialKit **2.0.2**, with Motion **13.4.4**. These are browser dependencies; they are not imported by the Rozenite React Native entry point.

The adapter renders sliders, toggles and color pickers with DialKit. `panel-core` remains the sole owner of schemas, values, validation notices, throttled patches, commits, triggers, stale protection, comparison and exports. It does not register controls with `DialStore`, use `useDialKit`, or mount `DialRoot`.

- Slider gestures send `setValue`; release, cancellation, key release or blur commits a changed valid value. Enter on the slider focuses the exact numeric field. Exact entry deliberately bypasses DialKit's built-in text editor, which clamps and rounds typed values; invalid input instead reaches RIP validation and displays its reason in the panel. Empty numeric drafts send nothing.
- Toggle changes send a patch followed by a commit.
- DialKit's color component exposes only `onChange`, so each emitted color sends a patch followed by a commit. There is no inferred drag-end event for the imperative picker.
- Springs use explicit damping/stiffness/mass inputs, preserving sibling fields. Béziers use four unrestricted numeric fields and a curve preview. The adapter does not convert RIP values into DialKit transition configurations, whose semantics differ. In particular, finite Bézier overshoot remains supported.
- Actions call `fireTrigger`; they do not masquerade as numeric values.

Stale controls are replaced with read-only values. The interactive component is unmounted, closing an open color picker and stopping transient gestures. A new schema/control identity also remounts the editor. This supplements the authoritative stale checks in `panel-core`.

## Verification

`pnpm --filter @runtime-inspector/panel-dialkit test` exercises the actual DialKit components in jsdom: keyboard changes and commits, schema identity, toggle/action routing, compound values, exact-input rejection with a real panel session, and color picker teardown. Canvas painting is outside jsdom; browser and hardware checks remain necessary.

The upstream stylesheet includes a Google Fonts import. Controls retain system-font fallbacks when the font is unavailable. This integration does not introduce timeline or recording functionality.
