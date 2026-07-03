# RFC 0003 — Runtime Value model and `useTunable`

- Status: accepted
- Author: Giulio Amato (draft), architect session (final form), 2026-07-03
- Affects: `runtime-react-native`, example, docs. No protocol change.
- Breaking: no (fully additive; existing APIs unchanged)

## Motivation

Runtime Inspector's job is not to build bindings; it is to make runtime values observable and tunable. The developer should state one thing — *this value is tunable* — and everything else (schema, panel, protocol wiring, target bookkeeping) must be the SDK's responsibility.

`useInspector` v2 (onChange, `$targets`) already removed the manual-wiring boilerplate for *grouped* panels. What is still missing is the single-value form: exposing one value should be one line, with no panel object, no group, no schema id to invent. The `// @inspect` directive already achieves this at the build-tool level (RFC 0002); this RFC adds the runtime-level equivalent and names the model both are built on.

The bar is: **simple, intuitive, magic**. One line to declare, zero lines to wire, nothing to debug.

## The model: Runtime Value

A **Runtime Value** is the SDK's fundamental unit. It owns:

- the live handle (a Reanimated mutable — Reanimated is required, per the v2 decision);
- the **target**: the last *decided* value (initial value, then every panel-applied value);
- metadata: name, label, inferred control kind, range/step/unit;
- its registration: which schema it appears in, and the (private) protocol binding.

Normative consequences:

1. **Bindings are not a public concept.** `bindSharedValue`/`bindValue`/`bindTrigger` remain exported as the low-level escape hatch, but no documented path requires them. All three entry points (`useInspector`, `useTunable`, `// @inspect`) register Runtime Values; the binding registry is an implementation detail behind them.
2. **The panel is a consequence.** Schemas are derived from registered Runtime Values; nothing is "built" by the developer.
3. **`set` assigns, it does not animate.** A Runtime Value is a value, not an animation engine. Applying a panel value writes `.value` and updates the target; *how* the app animates toward a target (withSpring, withTiming) stays the app's job, using the target the SDK tracks (`$targets` today). This resolves the target/current question: `current` is `handle.value` (whatever Reanimated has it at), `target` is SDK-tracked, and the SDK never drives motion.
4. **The protocol is untouched.** Runtime Values are an SDK-layer model over the existing schema/patch/commit/trigger messages.

## Public API: `useTunable`

```ts
const blur = useTunable("blur", 18, { min: 0, max: 40 });
// blur is a SharedValue — use it in worklets/styles as usual.
// It appears in the panel automatically.
```

- **Signature:** `useTunable(name, initial, options?)`. `name` is the explicit, stable identity (control id and default label source). No build-time magic is needed for identity; the zero-name experience remains the `// @inspect` directive's job.
- **Kind inference** reuses the existing table: `number → slider` (requires `min`/`max` in options — protocol mandates declared ranges, reject-don't-clamp), `boolean → toggle`, `string → color`, `{damping, stiffness} → spring`, 4-number array → bezier, **function → trigger** (a Runtime Action: the panel renders a button).
- **Options:** `min`, `max`, `step`, `unit`, `label`, `onChange` — same semantics as `useInspector` v2 (`onChange` fires after the handle is written, on every panel-applied value).
- **Returns** the Reanimated mutable (or the function itself for triggers). Nothing else to learn.
- **Lifecycle:** registers on first render, unregisters on unmount, republishes the shared schema (debounced) on both — hot-reload-safe through the same session-replacement path everything else uses. Because unmount releases the name, remounts do NOT accumulate `name2`, `name3` suffixes; a genuine collision (two live hooks claiming the same name) gets a suffix plus a dev warning, like `__riInspect`.
- **Placement:** all `useTunable` values land in the single shared auto schema (the same one `// @inspect` publishes to), so scattered one-liners across components collect into one panel without any grouping ceremony. Apps that want named groups/panels use `useInspector` — grouping is that API's reason to exist.
- **Production:** dev-only like everything else; in release builds the hook creates the mutable and does nothing else.

### The DX ladder after this RFC

1. `// @inspect min=0 max=40` on an existing `useSharedValue` — zero API, build-time (RFC 0002).
2. `useTunable("blur", 18, { min: 0, max: 40 })` — one line, runtime-level, no plugin required. **(this RFC)**
3. `useInspector(id, spec)` — grouped panels, onChange, `$targets`.
4. Explicit API (`definePanel` + `bind*`) — full control, works without Reanimated.

## Implementation

- Extend the auto-schema registry (`auto.ts`) into the shared Runtime Value registry: entries gain `onChange`, target tracking, and a `dispose()` that removes the entry, releases the name, and schedules a republish. Registration of value entries switches from `bindSharedValue` to the same setter wrapper `useInspector` v2 uses (write handle → update target → `onChange`), so panel patches behave identically across all entry points. Trigger entries register via `bindTrigger`.
- `useTunable` is a thin hook over that registry: build the mutable once (`useRef`), register on mount, dispose on unmount.
- `__riInspect` becomes another caller of the same registry (no behavior change; RFC 0002's semantics preserved, including the build-time min/max error and no directive-level triggers).
- The auto schema gains trigger support in its schema builder (needed for `useTunable` actions; additive).

## Explicitly deferred (with rationale)

- **Per-value `set()` / `reset()` / `export()` methods.** `set` is `handle.value = x`; reset/export have no concrete use case the panel doesn't already cover (copy-as-code lives in `panel-core`). Additive later if a real need appears.
- **Exposing `target` on the returned handle.** Attaching properties to Reanimated mutables is fragile across Reanimated versions; the grouped case already has `$targets`. Revisit with a concrete single-value use case.
- **`tunable.group(...)`.** `useInspector` is the grouping API; a second one would duplicate it.
- **SwiftUI / Compose / C++ runtimes.** The Runtime Value model permits other runtime implementations behind the same protocol, and that is all this RFC says about them. Designing that abstraction now would reintroduce the platform-agnosticism this project deliberately dropped: React Native + Reanimated is the platform.
- **Babel name inference for `useTunable`.** The explicit `name` argument is boring and reliable; the directive already covers the zero-name path.

## Test plan

- Registry: register/dispose lifecycle (dispose releases name and republishes; remount does not suffix), collision suffix + warning for two live claims, debounced republish, onChange + target update on applied patch, trigger registration and firing.
- Hook: registers once per mount, disposes on unmount (via testing-library or a minimal harness consistent with existing hook tests), number without min/max throws the actionable range error, production no-op.
- `__riInspect` regression: existing auto.test.ts suite stays green on top of the shared registry.
- Example: replace the example's `// @inspect` cardRadius companion `glow` value with a `useTunable` (one line) to prove the path end-to-end without disturbing the useInspector showcase.
- Manual (device): a `useTunable` slider moves the card; unmounting the component removes the control after republish.
