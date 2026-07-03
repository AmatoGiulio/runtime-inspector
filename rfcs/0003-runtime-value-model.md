# RFC 0003 — Runtime Value model, `useRuntimeValue` and `useAction`

- Status: accepted (amended after maintainer review: hook renamed `useTunable` → `useRuntimeValue`, function-to-trigger inference dropped in favor of an explicit `useAction`, identity principle added)
- Author: Giulio Amato (draft), architect session (final form), 2026-07-03
- Affects: `runtime-react-native`, example, docs. No protocol change.
- Breaking: no (fully additive; existing APIs unchanged)

## Motivation

Runtime Inspector's job is not to build bindings; it is to make runtime values observable and tunable. The developer should state one thing — *this value is tunable* — and everything else (schema, panel, protocol wiring, target bookkeeping) must be the SDK's responsibility.

`useInspector` v2 (onChange, `$targets`) already removed the manual-wiring boilerplate for *grouped* panels. What is still missing is the single-value form: exposing one value should be one line, with no panel object, no group, no schema id to invent. The `// @inspect` directive already achieves this at the build-tool level (RFC 0002); this RFC adds the runtime-level equivalent and names the model both are built on.

The bar is: **simple, intuitive, magic**. One line to declare, zero lines to wire, nothing to debug.

## The model: Runtime Value

A **Runtime Value** is the SDK's fundamental unit. It owns:

- the live handle (the runtime-native mutable value — in React Native, a Reanimated mutable; Reanimated is required, per the v2 decision);
- the **target**: the last *decided* value (initial value, then every panel-applied value);
- metadata: name, label, inferred control kind, range/step/unit;
- its registration: which schema it appears in, and the (private) protocol binding.

Normative consequences:

1. **Bindings are not a public concept.** `bindSharedValue`/`bindValue`/`bindTrigger` remain exported as the low-level escape hatch, but no documented path requires them. All three entry points (`useInspector`, `useRuntimeValue`, `// @inspect`) register Runtime Values; the binding registry is an implementation detail behind them.
2. **The panel is a consequence.** Schemas are derived from registered Runtime Values; nothing is "built" by the developer.
3. **`set` assigns, it does not animate.** A Runtime Value is a value, not an animation engine. Applying a panel value writes `.value` and updates the target; *how* the app animates toward a target (withSpring, withTiming) stays the app's job, using the target the SDK tracks (`$targets` today). This resolves the target/current question: `current` is `handle.value` (whatever the runtime has it at), `target` is SDK-tracked, and the SDK never drives motion.
4. **Runtime Values own their identity.** A Runtime Value is not "a number" — it is a runtime object with a stable name (its identity), metadata, a target, and schema membership. The registry defends that identity: re-registration replaces, disposal releases the name, and genuine live collisions are surfaced, never silently merged.
5. **The protocol is untouched.** Runtime Values are an SDK-layer model over the existing schema/patch/commit/trigger messages.

## Public API: `useRuntimeValue`

```ts
const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
// blur is the runtime-native mutable value — in React Native, a Reanimated
// SharedValue: use it in worklets/styles as usual.
// It appears in the panel automatically.
```

- **Signature:** `useRuntimeValue(name, initial, options?)`. `name` is the explicit, stable identity (control id and default label source). No build-time magic is needed for identity; the zero-name experience remains the `// @inspect` directive's job.
- **Kind inference** reuses the existing table: `number → slider` (requires `min`/`max` in options — protocol mandates declared ranges, reject-don't-clamp), `boolean → toggle`, `string → color`, `{damping, stiffness} → spring`, 4-number array → bezier. **Functions are NOT inferred as triggers** — passing a function is an error pointing to `useAction`. Using the JS type as semantics is a trap: today's `replay` function is obviously a trigger, tomorrow's arbitrary callback is not. Actions are declarations, not inferences.
- **Options:** `min`, `max`, `step`, `unit`, `label`, `onChange` — same semantics as `useInspector` v2 (`onChange` fires after the handle is written, on every panel-applied value).
- **Returns** the runtime-native mutable value (in React Native, the Reanimated mutable). The public contract is worded runtime-neutrally on purpose; the RN implementation detail is a SharedValue.
- **Lifecycle:** registers on first render, unregisters on unmount, republishes the shared schema (debounced) on both — hot-reload-safe through the same session-replacement path everything else uses. Because unmount releases the name, remounts do NOT accumulate `name2`, `name3` suffixes; a genuine collision (two live hooks claiming the same name) gets a suffix plus a dev warning, like `__riInspect`.
- **Placement:** all `useRuntimeValue` values land in the single shared auto schema (the same one `// @inspect` publishes to), so scattered one-liners across components collect into one panel without any grouping ceremony. Apps that want named groups/panels use `useInspector` — grouping is that API's reason to exist.
- **Production:** dev-only like everything else; in release builds the hook creates the mutable and does nothing else.

## Public API: `useAction`

```ts
const replay = useAction("replay", () => runReplayAnimation());
// The panel renders a button. `replay` is the function itself.
```

A Runtime Action is the command-side sibling of a Runtime Value: explicit, named, registered into the same shared schema as a `trigger` control, fired via the protocol's `control.trigger`. Same lifecycle as `useRuntimeValue` (register on mount, dispose on unmount, name release, live-collision suffix + warning). Options: `label`.

`useInspector`'s spec-level function entries remain as they are (a declarative spec object is an explicit-enough context for a function to mean "trigger"); revisit only if it proves confusing in practice.

### The DX ladder after this RFC

1. `// @inspect min=0 max=40` on an existing `useSharedValue` — zero API, build-time (RFC 0002).
2. `useRuntimeValue("blur", 18, { min: 0, max: 40 })` / `useAction("replay", fn)` — one line, runtime-level, no plugin required. **(this RFC)**
3. `useInspector(id, spec)` — grouped panels, onChange, `$targets`.
4. Explicit API (`definePanel` + `bind*`) — full control, works without Reanimated. Kept deliberately: builders, dynamic/generated schemas, and tooling will always need it.

## Implementation

- Extend the auto-schema registry (`auto.ts`) into the shared Runtime Value registry: entries gain `onChange`, target tracking, and a `dispose()` that removes the entry, releases the name, and schedules a republish. Registration of value entries switches from `bindSharedValue` to the same setter wrapper `useInspector` v2 uses (write handle → update target → `onChange`), so panel patches behave identically across all entry points. Trigger entries register via `bindTrigger`.
- Registration modes: lifecycle-less registrations (`__riInspect`, which runs in the render path) use replace-on-reregister semantics — re-registering the same name silently overwrites the entry in place (re-render/Fast Refresh safety); hook registrations claim the name and release it on dispose. A live cross-mode collision suffixes + warns.
- `useRuntimeValue` is a thin hook over that registry: build the mutable once (`useRef`), register on mount, dispose on unmount. `useAction` is the same wiring for a trigger entry.
- `__riInspect` becomes another caller of the same registry (no behavior change; RFC 0002's semantics preserved, including the build-time min/max error and no directive-level triggers).
- The auto schema gains trigger support in its schema builder (needed for `useAction`; additive).

## Explicitly deferred (with rationale)

- **Per-value `set()` / `reset()` / `export()` methods.** `set` is `handle.value = x`; reset/export have no concrete use case the panel doesn't already cover (copy-as-code lives in `panel-core`). Additive later if a real need appears.
- **Exposing `target` on the returned handle.** Attaching properties to Reanimated mutables is fragile across Reanimated versions; the grouped case already has `$targets`. Revisit with a concrete single-value use case.
- **`group(...)` for runtime values.** `useInspector` is the grouping API; a second one would duplicate it.
- **SwiftUI / Compose / C++ runtimes.** The Runtime Value model permits other runtime implementations behind the same protocol (the public contract already says "runtime-native mutable value", not "SharedValue"), and that is all this RFC says about them. Designing that abstraction now would reintroduce the platform-agnosticism this project deliberately dropped: React Native + Reanimated is the platform.
- **Babel name inference for `useRuntimeValue`.** The explicit `name` argument is boring and reliable; the directive already covers the zero-name path.

## Test plan

- Registry: register/dispose lifecycle (dispose releases name and republishes; remount does not suffix), replace-on-reregister for directive-mode entries (N re-renders → one control bound to the latest handle, silent), collision suffix + warning for two live claims, debounced republish, onChange + target update on applied patch, trigger registration and firing.
- Hooks: register once per mount, dispose on unmount, number without min/max throws the actionable range error, function initial throws pointing to `useAction`, `useAction` registers a trigger control and fires, production no-op.
- `__riInspect` regression: existing auto.test.ts suite stays green on top of the shared registry.
- Example: `glow` as a one-line `useRuntimeValue` driving a visible glow layer, without disturbing the useInspector showcase.
- Manual (device): a `useRuntimeValue` slider moves the card; Fast Refresh does not duplicate controls; unmounting removes the control after republish.
