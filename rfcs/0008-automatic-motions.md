# RFC 0008 — Automatic motions: scenes and curves without app code

- Status: proposed, 2026-10-03
- Author: orchestrator session, 2026-10-03
- Base: `feat/runtime-workbench-desktop` (after RFC 0006)
- Affects: `babel-plugin`, `runtime-react-native`, `workbench`, example app, docs
- Protocol: **no change** — automatic scenes are ordinary entries of the RFC 0006 `scenes` schema; automatic probes are ordinary RFC 0005 probes
- Breaking: no

## Motivation

The product promise is "install, run `init`, open the Workbench — write nothing in the app". RFC 0005 §3a–§3c already delivers it for the timeline: the Babel plugin discovers `withTiming` / `withSpring` / `withDelay` assignments and makes their literals editable. Scenes (RFC 0006) and recorded curves (RFC 0005 probes) still need app code: `defineScenes`, `useScene`, `useRuntimeProbe`.

The plugin already knows, for every discovered animation, the function it runs in (`enclosure: ["ProductRevealDemo", "play"]`). This RFC lets the plugin turn those functions into scenes, and the animated shared values into probes, by itself. The explicit APIs stay as overrides.

## Decisions

### 1. Motion functions

A **motion function** is the nearest function enclosing a discovered animation assignment that is one of:

1. a `function name() {}` declaration that is a direct statement of a component body;
2. `const name = <arrow | function expression>` or `const name = useCallback(<arrow | function expression>, deps)`, a direct declaration of a component body;
3. the callback of `useEffect` / `useLayoutEffect` called as a direct statement of a component body, **only if its body is pure motion**: every statement is an assignment to a `.value` member or a call to a motion function of the same component. Anything else (subscriptions, timers, state updates) makes it not replayable; its animations still show on the timeline.

A *component* is a module-level function declaration, or a module-level `const` initialized with an arrow or function expression, whose name starts with an uppercase letter (including `export default function Name`).

Walking up from the assignment stops at the component: an animation inside a `setTimeout` callback inside `replayTransition` belongs to `replayTransition`. Inline JSX handlers and nested components are out of scope for this pass.

A function that is passed to `useScene` / `useAction`, or initialized by `useScene(...)`, is explicit and is skipped.

### 2. Injection (dev only)

Every injection sits at the top level of the component body, so it is an unconditional hook call:

```ts
function play() { … }
__riMotion("src/ProductRevealDemo.tsx:ProductRevealDemo.play", play, meta);   // after a declaration

const play = __riMotion(id, () => { … }, meta);                               // wraps an initializer
const play = __riMotion(id, useCallback(() => { … }, []), meta);

useEffect(__riMotion(id, () => { … }, meta), []);                              // wraps a pure-motion effect
```

`__riMotion` returns its function argument **unchanged** (identity preserved, so dependency arrays and callers behave exactly as before). Production builds are untouched.

`meta`:

```ts
{
  component: "ProductRevealDemo",
  name: "play",            // "effect" for an effect
  file: "src/ProductRevealDemo.tsx",
  line: 22,
  title?: string,          // from a `// @scene` comment
  group?: string,
  callsites: string[]      // callsite ids of the animations inside
}
```

Scene id: `<file>:<Component>.<name>`; an effect uses `effect@<line>` as its name.

### 3. Runtime: `__riMotion`

A hook (ref + effect). On mount it binds an RFC 0006 scene with that id, playing the latest function; on unmount it unbinds. Defaults: group = the component name humanized ("Product reveal demo"), title = the function name humanized ("Play", "Replay transition"; an effect is "On mount").

"Already ran" detection (RFC 0006 §3 step 4) cannot rely on a wrapper because the app keeps calling its own function. For automatic scenes, the scene counts as already played when any of its `callsites` reported `animation.started` after the binding became active. The animation observer notifies the scenes module in-process.

An explicit `defineScene(id, …)` with the automatic id merges as usual, so an app can add `link` / `open` / title to an automatic scene without changing it.

### 4. `// @scene` comment

A leading comment on the declaration or effect statement:

```ts
// @scene "Product reveal" group="Store"
function play() { … }
```

sets `title` / `group`. `// @scene off` excludes the function. Invalid syntax is a build error with a clear message, like `// @inspect`.

### 5. Automatic probes

A `useSharedValue(<number or boolean literal>)` declared at the top level of a component and assigned by a discovered animation in the same component is wrapped:

```ts
const titleY = __riProbe(useSharedValue(24), "titleY", { component: "ProductRevealDemo", file });
```

`__riProbe` registers a numeric/boolean probe in the `auto` trace schema (RFC 0005), labelled `Product reveal demo · titleY`, and returns the shared value unchanged. Composes with `__riInspect`. Recording then needs no `useRuntimeProbe`. The RFC 0005 cap of 16 simultaneous probes per recording still applies; the Workbench chooses the probes of the selected scene.

### 6. Navigation

An automatic scene can always be replayed while it is on screen. Reaching it from elsewhere needs a route; that is the next step (Expo Router file-based routes inferred by the plugin), specified separately. Until then `defineScene(id, { open | link })` adds navigation explicitly.

## Out of scope

- Inline JSX handlers (`onPress={() => …}`), class components, nested component definitions.
- Replaying effects that are not pure motion.
- Inferring routes (follow-up).

## Test plan

- Plugin: each motion-function shape, pure/impure effects, nearest-ancestor walk through a `setTimeout` callback, explicit `useScene` skipped, `// @scene` title/group/off and invalid syntax, probe wrapping only for animated top-level shared values, production untouched, output still valid for the Reanimated plugin.
- Runtime: `__riMotion` binds/unbinds, returns the same function, callsite-based "already ran", explicit declaration merge; `__riProbe` registers and composes with `__riInspect`.
- Example: with `useScene` / `defineScenes` / `useRuntimeProbe` removed, the Workbench lists the motions and replays them on screen.

## Amendment (2026-10-30): emitted shape under the React Compiler

The React Compiler (`babel-plugin-react-compiler`, run by `babel-preset-expo` when an app enables it) constrains what the plugin may emit:

- It memoizes an ordinary call into an `if ($[n] !== …)` branch, so a helper that calls React hooks must be a `use*` hook — `__riMotion` / `__riProbe` were not.
- It freezes every argument of a hook, so a hook must not receive the motion function or the shared value: a callback that assigns `.value` then fails to compile ("This value cannot be modified"). It also stops treating a `useSharedValue` result as a shared value once that result is wrapped in another call.
- It resolves identifiers through Babel's scope, so inserted declarations must be registered there.

Each motion and probe is therefore a hook that takes only static data and returns an **instance token** (a string), plus a plain function that hands the function or shared value to that instance. The `useSharedValue(...)` declaration itself is left as written:

```ts
function play() { … }
const _riScene = useRiScene("src/ProductRevealDemo.tsx:ProductRevealDemo.play", meta);
__riMotionFn(_riScene, play);

const _riScene2 = useRiScene(id, meta);
const play = __riMotionFn(_riScene2, () => { … });       // wraps an initializer
const _riScene3 = useRiScene(id, meta);
useEffect(__riMotionFn(_riScene3, () => { … }), []);     // wraps a pure-motion effect

const titleY = useSharedValue(24);
const _riProbe = useRiProbe("titleY", { component: "ProductRevealDemo", file });
__riProbeValue(_riProbe, titleY);
```

`useRiScene` binds the scene while its component instance is mounted and plays the function that instance last recorded through `__riMotionFn`; several mounted instances of a component (list rows) each keep their own. `useRiProbe` / `__riProbeValue` do the same for probes. If the compiler memoizes a plain call, it only skips recording an unchanged value. `__riMotion` and `__riProbe` stay exported, unchanged, for code transformed by earlier plugin versions; the plugin and `@runtime-inspector/react-native` must be upgraded together.

The plugin also runs the `// @inspect` rewrite and the animation-assignment discovery from its `Program.enter`, on the untouched program: the compiler rewrites component bodies from its own `Program.enter`, after which the directive comments and the source locations callsite ids are built from are gone. This relies on the plugin being listed in the app's `plugins` (Babel runs plugins before presets), which is what `runtime-inspector init` writes.

`packages/babel-plugin/src/react-compiler.test.ts` runs the real compiler (1.0.0) and checks, for five motion shapes, that it logs the same events (compiled, or skipped for the same reason) with Runtime Inspector as without, and that no injected hook lands in a memoization branch.
