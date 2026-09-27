# DialKit rendering

Both the web panel and the Rozenite DevTools panel render the same component, `InspectorPanel` from `packages/panel-dialkit`. It is laid out as an inline [DialKit](https://github.com/joshpuckett/dialkit) panel — one section per schema, one folder per group — and uses DialKit **2.0.2** components and styles (with Motion **13.4.4**). These are browser dependencies; the Rozenite React Native entry point never imports them.

```tsx
import { InspectorPanel } from "@runtime-inspector/panel-dialkit";
import "@runtime-inspector/panel-dialkit/styles.css";

<InspectorPanel session={session} state={state} canApplySource />
```

`panel-core` remains the sole owner of schemas, values, validation notices, throttled patches, commits, triggers, stale protection, comparison and exports. The adapter does not register controls with `DialStore`, use `useDialKit`, or mount `DialRoot`: it reuses DialKit's markup (`dialkit-root` / `dialkit-panel` in inline mode) and its controlled components. Additional styles read DialKit's `--dial-*` tokens only, so light/dark/system theming is DialKit's.

## Control mapping

| RIP kind | DialKit rendering | Patch / commit |
| --- | --- | --- |
| `slider` | `Slider` | patch on every change; one commit when the pointer/key gesture ends or on blur |
| `toggle` | `Toggle` | patch + commit per change |
| `color` | `ColorControl` | patch + commit per emitted color (the picker exposes no drag-end event) |
| `spring` | `Folder` + `SpringVisualization` + stiffness/damping/mass `Slider`s | as slider; siblings preserved |
| `bezier` | `Folder` + draggable `EasingVisualization` + x1/y1/x2/y2 `Slider`s | as slider; tuple shape preserved |
| `trigger` | `dialkit-button` | `fireTrigger` only — never a value |

- **Exact entry.** DialKit's own value editor clamps and rounds typed input, so it is disabled. Press Enter on a focused slider (or double-click it) to open an exact field; its value goes to RIP validation unchanged and an out-of-range number is rejected with a visible reason, never clamped.
- **Display ranges.** Spring fields use `control.ranges` when declared, otherwise stiffness 1–1000, damping 1–100, mass 0.1–10. Bézier sliders span x 0–1 and y −1–2. Every display range widens to include the current value, so a slider never misrepresents a value it did not produce. DialKit's spring "Time" mode is not offered: its duration/bounce parameters are not RIP's spring model.
- **Stale schemas.** Controls are replaced by read-only rows. The interactive component unmounts, closing an open color picker and stopping transient gestures. A new schema/control identity also remounts the editor. This supplements the authoritative stale checks in `panel-core`.

## Panel chrome

- Section toolbar: copy the schema as TypeScript; **Apply all to code** when `canApplySource` is set and the schema has anchored controls.
- Per-control **Apply to code** (hover affordance) for controls with a `source` anchor.
- A collapsible **Compare** folder with Save/Apply for snapshots A and B, and a **Show code** export preview.

`canApplySource` is `true` in the web panel (the broker routes `source.apply` to the CLI's `workspace` client) and `false` in Rozenite, whose direct bridge has no workspace.

## Verification

`pnpm --filter @runtime-inspector/panel-dialkit test` exercises the actual DialKit components in jsdom: keyboard gestures and commits, schema identity, toggle/action routing, compound values and range widening, exact-input rejection with a real panel session, color picker teardown, write-back affordances, A/B routing and stale freezing. Canvas painting is outside jsdom; the rendered panel has been checked in a browser against a live broker.

The upstream stylesheet includes a Google Fonts import (Geist Mono). Controls keep system-font fallbacks when the font is unavailable.
