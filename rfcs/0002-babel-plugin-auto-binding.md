# RFC 0002 — Babel plugin: dev-only auto-binding via @inspect directive

- Status: implemented
- Author: architect session, 2026-07-03
- Affects: new `packages/babel-plugin`, `runtime-react-native` (auto-schema helper), example, docs
- Breaking: no (fully additive; no protocol change)

## Motivation

The DX ladder is: explicit API (configure) → `useInspector` (declare) → **switch on**. The last step: a developer annotates an existing `useSharedValue` and it appears in the panel — no imports, no hook, no wiring. This is the roadmap's "dev-only auto-binding" item.

## Design principle: predictable magic

No blanket auto-exposure of every shared value. Reasons: panel flooding with internal values, and slider ranges cannot be guessed — the protocol mandates declared min/max with reject-not-clamp semantics (see protocol-stability.md); a range heuristic would contradict it. Exposure is opt-in per value via a directive comment.

## Directive syntax

A line comment immediately preceding (or trailing) a `useSharedValue` declaration:

```
// @inspect min=-120 max=120 step=1 unit=px label="Move X"
const moveX = useSharedValue(0);
```

- `key=value` pairs; quoted values for strings with spaces. All optional except: **numeric initial values REQUIRE min and max** (build-time error otherwise, mirroring `useInspector`'s bare-number rule with the same actionable message).
- Control kind inferred from the initial value at runtime (same inference table as `useInspector`: number→slider, boolean→toggle, string→color, spring shape→spring, 4-array→bezier).
- Label defaults to the variable name via the shared `deriveLabel`.

## Transform

`packages/babel-plugin` (name: `@runtime-inspector/babel-plugin`). For an annotated declaration, the plugin rewrites:

```
const moveX = useSharedValue(0);
// →
const moveX = __riInspect(useSharedValue(0), "moveX", { min: -120, max: 120, step: 1, unit: "px", label: "Move X" });
```

- `__riInspect` auto-imported from `@runtime-inspector/react-native` (added to the import list; helper exported from the SDK).
- The plugin only transforms in development (`api.env() !== "production"`); in production the code is untouched and the directive is a plain comment.
- Only `useSharedValue` call expressions are matched in the first pass (identifier or member callee named `useSharedValue`).

## Runtime helper (`runtime-react-native`)

`__riInspect(sharedValue, name, meta)`:

- No-op (returns the value unchanged) when `!__DEV__`.
- Registers the value in a module-level **auto-schema registry**: schema id `"auto"`, title `"Inspected values"`, one group, control id = `name` (on collision: `name`, `name2`, ... with a dev warning), binding `auto.${name}`, kind inferred from the current value shape (reuse `buildInspector`'s inference internals — extract/share, don't duplicate).
- Publishing is debounced (~100ms after the last registration) through the normal `definePanel` + `connect()` path, so hot reload re-registers cleanly through the existing session-replacement logic. Values registered later re-publish the schema (additive).
- Returns the same shared value (transparent to Reanimated).

### Amendment (issue #8): disposal on unmount

Originally `__riInspect` never disposed its registration, so after navigating away the control stayed in the panel, driving a value nothing rendered. It now has the mount lifecycle the other entry points have. For a declaration in a component or hook body the plugin emits:

```ts
const moveX = useSharedValue(0);
const _riInspect = useRiInspect("moveX");
__riInspect(moveX, "moveX", { min: -120, max: 120, step: 1, unit: "px", label: "Move X" }, _riInspect);
```

- `useRiInspect(name)` takes only static data (the RFC 0008 amendment's React Compiler rule) and returns an instance token; `__riInspect` records its registration under that token.
- On unmount the instance's control is removed, unless a newer instance rendered in the meantime (a navigation renders the new screen before the old one's cleanup) and owns it. Several mounted instances (list rows) still share one control: the latest render owns it, and when the owner unmounts the control moves to the newest instance still mounted.
- Re-rendering an instance keeps its existing control id, including a collision suffix. New registrations skip ids still held by another live entry, even when disposal leaves gaps between suffixes.
- An initial effect must not replace the newer rendered owner, including when sibling instances commit together.
- A remount without a render (StrictMode, a kept-alive screen) registers again with the value the instance last recorded. A screen opened again gets the bare name back, never a suffix.
- Without a token (a hand-written call, or a declaration outside a function body, which is still wrapped in place) nothing changes: the registration is never disposed.
- The plugin and `@runtime-inspector/react-native` must be upgraded together, as for the RFC 0008 amendment.

## Scope limits (first pass)

- No trigger support via directive (functions are not `useSharedValue`s; `useInspector` covers triggers).
- No cross-file grouping config; single "auto" schema, group per... single group, control labels carry context.
- No expo-router/Metro config automation beyond documented `babel.config.js` one-liner.

## Test plan

- Plugin: snapshot tests via `@babel/core` transformSync — annotated declaration transforms (with auto-import added), unannotated untouched, numeric without min/max fails with the actionable error, production env leaves code untouched, trailing-comment variant, quoted label parsing.
- Helper: registry tests (inference reuse, collision suffix, debounce publish via fake timers, no-op in production mode).
- Example: annotate ONE value in the example app (e.g. a new subtle `cardRadius` shared value) with `// @inspect min=8 max=48` and add the plugin to the example's babel.config.js — proving the end-to-end path without disturbing the useInspector showcase.

## Docs

- README: the three-step DX ladder (explicit → hook → directive) with the directive snippet.
- getting-started: directive as the fastest path for existing codebases.
- architecture: one paragraph in the binding model section.
- roadmap: move the auto-binding item from "Later" to done-first-pass.
