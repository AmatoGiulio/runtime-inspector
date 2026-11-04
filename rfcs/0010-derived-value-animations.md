# RFC 0010 — Animations returned from `useDerivedValue`

- Status: draft, 2026-11-05
- Author: maintainers
- Origin: issue #8 (item 1, second part), found on a real Expo SDK 58 app
- Affects: `protocol` (additive), `babel-plugin`, `runtime-react-native`, `cli` (workspace), docs
- Breaking: no — one optional field on `LiteralAnchor`

## Motivation

Discovery (RFC 0005 §3, RFC 0008) finds animations assigned on the JS thread: `x.value = withSpring(...)` (and `x.set(withSpring(...))` once the RFC 0007 amendment from issue #8 lands). A second common style returns the animation from a derived value:

```ts
const progress = useDerivedValue(() => {
  return withTiming(open.value ? 1 : 0, { duration: 300 });
});
```

In the app behind issue #8 this pattern appears 75 times (against 96 `.set(...)` calls and no `.value =` assignments). None of it gets sliders today.

It cannot reuse the existing helpers. The `useDerivedValue` callback is a worklet and runs on the UI thread. `__riAnimationConfig` and the other helpers read module-level `Map`s and can warn through the JS console, and none of that exists on the UI thread.

## Design principle

Keep the UI thread trivial. Everything that registers controls, talks to the broker or warns stays on the JS thread, in a hook called during render. The worklet only reads numbers from a shared value, the same mechanism `useRuntimeValue` already uses: a slider backed by a `makeMutable` shared value that the panel updates.

## 1. What is discovered

The Babel plugin discovers an animation in a `useDerivedValue` callback when all of these hold:

- `useDerivedValue` is imported from `react-native-reanimated` (aliases respected) and is called in a component body before its first `return` (the RFC 0008 rule), with the result assigned to a `const` with an identifier name;
- its first argument is an inline arrow or function expression, not a reference;
- the animation is the callback's arrow expression body or the argument of a `return` statement at the top level of the callback (not inside a nested function);
- the returned expression has an accepted shape: `withTiming(...)` / `withSpring(...)`, or `withDelay(<n>, ...)` around one (RFC 0005 §3c), with the same argument guards as today.

Each matching return is its own callsite. The id adds a `derived` marker so it never collides with an assignment: `<file>:<line>:<column>:<kind>:derived:<name>`, where `<name>` is the `const` name and line/column are those of the returned expression.

Literal parameters are the usual ones (`duration`, `damping`, `stiffness`, `mass`, and the RFC 0009 duration-spring parameters once accepted) plus the `delay` of an existing `withDelay`. A bare call gets no delay slider here: adding a delay would mean wrapping the call on the UI thread, which is left for later.

Outside these rules nothing is touched: a missed animation is better than JS-only code on the UI thread.

## 2. Emitted code

```ts
const _riLiterals = useRiLiterals("src/Sheet.tsx:12:9:timing:derived:progress", [
  { key: "duration", controlId: "…:duration", label: "progress duration", declared: 300,
    min: 0, max: 10000, step: 1, unit: "ms", literal: { … } }
]);
const progress = useDerivedValue(() => {
  return withTiming(open.value ? 1 : 0, { duration: _riLiterals.value.duration });
});
```

- `useRiLiterals(callsiteId, bindings)` is a hook with static arguments only, so it follows the React Compiler rules of the RFC 0008 amendment. It is inserted before the `useDerivedValue` declaration.
- It creates a shared value (`makeMutable`) holding `{ [key]: declared }`, registers one slider per binding in the `auto` schema with the binding's `literal` anchor (RFC 0007), and writes `shared.value = { ...current, [key]: value }` when the panel patches a slider. It disposes its controls on unmount.
- In the worklet, each eligible numeric literal is replaced by `_riLiterals.value.<key>`. Nothing else in the callback changes. The Reanimated Babel plugin, which runs after ours, captures `_riLiterals` like any other shared value.
- Production builds are untouched, as for every other transform.

**Behavior difference, on purpose.** Reading `_riLiterals.value` inside `useDerivedValue` makes the derived value depend on it. Moving a slider therefore re-runs the callback at once and starts a new animation from the current value. Assignment-based animations, by contrast, pick up a change the next time they play. For a derived value this is the natural Reanimated behavior, and it gives live feedback while tuning. The panel should say "applies live" on these controls.

## 3. Protocol

`LiteralAnchor` gains one optional field:

```ts
export interface LiteralAnchor {
  // …existing fields
  /** Which source form the literal lives in. Absent means "assignment" (RFC 0007). */
  form?: "assignment" | "derived";
}
```

For `form: "derived"`, `target` is the `const` name (`"progress"`), and line/column are those of the returned expression (tiebreaker only, as before). The `.set(...)` amendment to RFC 0007 can use the same field (`form: "set"`) instead of encoding the form in `target`; whichever lands first defines the field, the other adds its value.

An optional field is additive under [protocol-stability.md](../docs/protocol-stability.md). No new message, no taxonomy change. `source.apply` is unchanged: it carries the anchor as it is.

## 4. Apply to code (CLI workspace)

For `form: "derived"` the RFC 0007 §3 procedure changes only in step 2. Candidates are `VariableDeclarator`s whose identifier text equals `target`, whose initializer is a `useDerivedValue(...)` call with an inline function, and which are inside the `enclosure` chain. Inside that function, each top-level return (or arrow expression body) whose expression has the recorded callee shape is a match; ties are broken by line/column. Steps 3–5 (locate the literal, compare with `init`, write) are unchanged. The RFC 0007 codes keep their meaning.

## 5. Observation, timeline and scenes

Not in this RFC. `__riObserveAnimation` runs on the JS thread and feeds the Workbench timeline and scenes. Reporting a derived animation's start from the UI thread (through `runOnJS` / `scheduleOnRN`) is a separate step. Until then these animations get sliders and *Apply to code*, but do not appear as blocks in the timeline.

## Out of scope

- `useAnimatedStyle` and `useAnimatedReaction` callbacks, gesture callbacks, `runOnUI` / `scheduleOnUI`.
- Callbacks passed by reference, conditional or nested returns inside inner functions.
- Adding a delay to a bare call.
- Timeline observation (§5).

## Open questions

- Reanimated 4 moves worklets to `react-native-worklets`. `makeMutable` is still exported by Reanimated 4, but this must be verified on the installed version, as `useRuntimeValue` already does.
- Whether a slider change should restart the derived animation (as above) or wait for the next natural re-run. The proposal chooses live. A "pause live updates" toggle can come later if it proves annoying.

## Test plan

- Protocol: fixtures for a control whose literal has `form: "derived"`, and a `source.apply` carrying it. A missing `form` still parses as an assignment.
- Plugin: arrow expression body, `return` at the top level, `withDelay` around the animation; no transform for a callback by reference, a nested return, or a call outside a component body; the emitted hook takes only static arguments and sits outside every React Compiler memoization branch (same check as `react-compiler.test.ts`); output still valid for the Reanimated plugin; production untouched.
- Runtime: `useRiLiterals` registers the sliders, a patch updates the shared value, unmount disposes.
- CLI: write a duration and a `withDelay` delay in a derived callback; `DECLARATION_MOVED` / `AMBIGUOUS` with two derived values of the same name in different components.
- End to end on the Simulator, with Reanimated 3 and 4: move the slider, the derived animation restarts with the new value, *Apply to code*, Fast Refresh.
