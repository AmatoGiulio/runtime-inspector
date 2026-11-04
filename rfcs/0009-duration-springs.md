# RFC 0009 — Duration-based springs

- Status: draft, 2026-11-05
- Author: maintainers
- Origin: issue #8 (item 3), found on a real Expo SDK 58 app
- Affects: `protocol` (additive), `babel-plugin`, `cli` (workspace), `panel-core`, docs
- Breaking: no — one new value in `AnimationLiteralParameter` (a relaxed validation rule)

## Motivation

Reanimated (since 3.6) accepts two kinds of spring config:

```ts
withSpring(1, { damping: 14, stiffness: 160 });      // physical
withSpring(1, { duration: 400, dampingRatio: 0.7 }); // duration-based
```

Duration-based springs are common in real apps because they are easier to reason about. Today the Babel plugin only turns `damping`, `stiffness` and `mass` into sliders (RFC 0005 §3b). A duration-based spring therefore gets no duration or bounciness slider, and a test asserts that such configs are left alone. Worse, if a config mixes both kinds, the plugin can offer a `damping` slider that Reanimated ignores.

This RFC adds sliders for duration-based springs, keeps *Apply to code* (RFC 0007) working for them, and gives the timeline their real length.

## What Reanimated does (verified on 3.16)

From `react-native-reanimated/src/animation/spring.ts` and `springUtils.ts` in 3.16.7:

- A spring is duration-based when `userConfig.duration || userConfig.dampingRatio` is truthy (`useDuration`). Defaults in that mode: `duration: 2000`, `dampingRatio: 0.5`, `stiffness: 100`.
- In duration mode `damping` and `mass` are ignored. Reanimated computes a new `mass` (bisection, `calculateNewMassToMatchDuration`) from `stiffness`, `dampingRatio`, the distance to travel, the start velocity and `restSpeedThreshold`, so the motion settles at `duration`. The animation then ends exactly when `duration` has elapsed.
- `stiffness` still matters in duration mode, through that mass calculation.
- The TypeScript type forbids `mass` / `damping` together with `duration` / `dampingRatio`, but plain JavaScript can still pass both.

**To verify before implementation:** the same rules on Reanimated 4.x. Reanimated 4 changed spring defaults (see the alpha.1 notes: the default `mass` is not 1), and its duration semantics may differ (for example a "perceived" duration shorter than the real settle time). The implementation must follow the installed version, and the test plan below checks both majors.

## 1. Spring mode, decided statically

The Babel plugin classifies each discovered `withSpring` config object literal:

- **duration mode**: the object has a `duration` or a `dampingRatio` member (whatever its value);
- **physical mode**: otherwise.

Sliders by mode:

| Mode | Sliders (when written as an eligible numeric literal) |
| --- | --- |
| physical | `damping`, `stiffness`, `mass` (unchanged) |
| duration | `duration`, `dampingRatio`, `stiffness` |

In duration mode the plugin never emits `damping` or `mass` sliders, even when they appear in the object: Reanimated ignores them there, and a slider that does nothing breaks the "applied exactly or rejected" contract. A config that is not an object literal, or contains a spread, gets no sliders (unchanged rule).

Slider ranges (a declared literal outside the range gets no slider, as today):

| Parameter | min | max | step | unit |
| --- | --- | --- | --- | --- |
| `duration` (spring) | 0 | 10000 | 1 | ms |
| `dampingRatio` | 0.05 | 2 | 0.01 | — |

`dampingRatio` 1 is critically damped, above 1 overdamped, below 1 bouncy. 0 is excluded: the spring would never settle.

## 2. Protocol

```ts
export type AnimationLiteralParameter =
  | "duration" | "damping" | "stiffness" | "mass" | "delay"
  | "dampingRatio"; // new
```

`LiteralAnchorSchema.parameter` accepts `"dampingRatio"`. `duration` already exists (timing); with `callee: "withSpring"` it now also names a spring's duration. No new message, no new field, no taxonomy change: these are ordinary `slider` controls in the `auto` schema carrying a `literal` anchor (RFC 0007).

Compatibility: accepting a new enum value relaxes a validation rule (additive under [protocol-stability.md](../docs/protocol-stability.md)). A panel built before this RFC would reject a schema containing `parameter: "dampingRatio"`. That is acceptable because all packages ship in lockstep; the release notes must say so.

Fixtures: a control with a `dampingRatio` literal anchor, and a `source.apply` request for it.

## 3. Runtime

No new helper. `__riAnimationConfig` already overrides any bound key, so `duration` and `dampingRatio` bindings work like the others. The animation observation (`runtime.animation.started`) keeps sending the static `config` as today; it now includes `duration` / `dampingRatio` when they are static.

## 4. Apply to code (CLI workspace)

RFC 0007 §3 applies unchanged: the literal is located by key in the animation call's second argument. Only the accepted parameter set grows. `EXPRESSION_MISMATCH` also covers a config whose mode changed since the app was built (for example a `duration` member was added next to a tuned `damping`); the workspace re-classifies the object with the same rule as the plugin and refuses to write a parameter the current mode ignores.

## 5. Panel and Workbench

- **Expected length.** `panel-core`'s `expectedAnimationDuration` estimates a spring's length from `damping` / `stiffness` / `mass` (`sampleSpringCurve`, `durationBasis: "spring-estimate"`). A duration-based spring returns no estimate today. With this RFC it returns its declared length, `{ ms: duration, basis: "declared" }`, so the Workbench timeline draws it at the right size before it completes (on Reanimated 3; on 4 it follows whatever §"To verify" finds). `dampingRatio` alone (default `duration`) uses Reanimated's default duration.
- **Sliders.** Labels follow the existing `"<target> <parameter>"` form (`"titleY duration"`, `"titleY dampingRatio"`); DialKit renders them as ordinary sliders.

## Out of scope

- The `spring` control kind used by `useInspector` / `// @inspect` on a spring config object (`SpringValue`). Extending `SpringValue` with `duration` / `dampingRatio` is a separate, additive change.
- `clamp`, `overshootClamping`, `velocity`, thresholds.
- Converting a spring between modes from the panel.

## Test plan

- Protocol: fixtures above; a `dampingRatio` literal outside the slider range is still a valid anchor (ranges live on the control).
- Plugin: duration mode emits `duration` + `dampingRatio` (+ `stiffness`) bindings and never `damping` / `mass`; physical mode unchanged; mixed config treated as duration mode; the existing "duration springs are not wrapped" test is replaced.
- Runtime: overriding `duration` and `dampingRatio` reaches the `withSpring` call.
- CLI: write `duration` and `dampingRatio` on a spring; refuse a `damping` write when the object is now in duration mode.
- panel-core: a duration-based spring gets `durationBasis: "declared"` with its declared (or default) duration; physical springs keep the estimate.
- End to end on the Simulator, once with Reanimated 3 and once with Reanimated 4: change the duration and `dampingRatio` sliders from the panel, replay, check the timeline length, *Apply to code*, Fast Refresh.
