# RFC 0007 — Write-back for animation literals ("Apply to code" for the timeline)

- Status: accepted, 2026-10-04
- Author: orchestrator session, 2026-10-03
- Base: `feat/runtime-workbench-desktop` (after RFC 0006 and RFC 0008)
- Affects: `protocol` (additive), `babel-plugin`, `runtime-react-native`, `cli` (workspace), `panel-core`, `workbench`, docs
- Breaking: no — one optional control field, one optional request field, a relaxed request rule

## Motivation

RFC 0005 §3b/§3c turned the literals of discovered animations into ordinary controls: a timing `duration`, a spring's `damping` / `stiffness` / `mass`, and a start delay. The Workbench edits them by dragging blocks and through the Inspector, and the app replays. Then the work is lost: a Metro reload brings back the literals in the file. Both RFCs recorded the gap: "source write-back of the tuned duration … needs its own anchor shape and a follow-up RFC 0004 amendment".

This RFC closes it. After arranging a scene, **Apply to code** rewrites the numbers in the source file — `withDelay(140, withTiming(0, { duration: 380 }))` becomes `withDelay(180, withTiming(0, { duration: 420 }))` — and Fast Refresh brings the app back with the new literals as its defaults.

## Design principle

Same as RFC 0004: the anchor is structure, not a position. An animation literal is identified by the assignment it belongs to (file, enclosing function chain, assignment target text), the animation callee, and the parameter key. Line/column of the assignment are only a tiebreaker. The current literal text must equal the text the running app was built from, or nothing is written.

## 1. `LiteralAnchor` and `InspectorControl.literal`

```ts
export type AnimationLiteralParameter = "duration" | "damping" | "stiffness" | "mass" | "delay";

export interface LiteralAnchor {
  /** File relative to the Babel root, as in SourceAnchor. */
  file: string;
  /** Start of the assignment expression (tiebreaker only). */
  line: number;
  column: number;
  /** Enclosing function/component names, outermost first. */
  enclosure: string[];
  /** Source text of the assignment target, e.g. "titleY.value". */
  target: string;
  /** The animation call inside the assignment. */
  callee: "withTiming" | "withSpring";
  parameter: AnimationLiteralParameter;
  /**
   * Source text of the literal as built. `null` only for `delay` on a bare call
   * (no `withDelay` in source): writing a delay then wraps the call.
   */
  init: string | null;
}

interface BaseControl<TKind, TValue> {
  // ...existing fields, including `source?: SourceAnchor`
  literal?: LiteralAnchor;
}
```

A control has at most one of `source` and `literal`. Only the slider controls registered for animation parameters (the `auto` schema entries created by `__riAnimationConfig`, `__riAnimationDelay`, `__riAnimationStart`) carry `literal`. The Babel plugin emits the anchor in each binding descriptor; the runtime copies it onto the control.

## 2. `source.apply` requests

A request carries either `anchor` (RFC 0004, unchanged) or `literal`:

```json
{ "controlId": "src/WelcomeDemo.tsx:41:4:timing:titleY:delay", "kind": "slider", "value": 180,
  "literal": { "file": "src/WelcomeDemo.tsx", "line": 41, "column": 4, "enclosure": ["WelcomeDemo", "play"],
               "target": "titleY.value", "callee": "withTiming", "parameter": "delay", "init": "140" } }
```

Validation: exactly one of `anchor` / `literal`; `kind` must be `slider` and `value` a finite number when `literal` is present. Making `anchor` optional relaxes a rule (additive under docs/protocol-stability.md). `source.applyResult` is unchanged; the RFC 0004 codes are reused with these meanings for literals:

| Code | Literal meaning |
| --- | --- |
| `PARSE_FAILURE` | the file no longer parses |
| `DECLARATION_MISSING` | no assignment with this target, callee and enclosure; or the parameter is no longer a numeric literal there |
| `DECLARATION_MOVED` | several matches, none at the recorded line/column |
| `DECLARATION_AMBIGUOUS` | several matches even after the tiebreaker |
| `EXPRESSION_MISMATCH` | the literal text differs from `init` (edited since the app was built), or a bare call now has a `withDelay`, or vice versa |
| `WRITE_FAILURE` | filesystem error |

## 3. Workspace procedure (CLI)

1. Read and parse the file (same as RFC 0004).
2. Candidates: `AssignmentExpression` with `=`, left-hand source text equal to `target` (whitespace-insensitive), inside the `enclosure` chain, whose right side is `callee(...)` or `withDelay(<arg>, callee(...))`. Tiebreak by line/column.
3. Locate the literal:
   - `duration` / `damping` / `stiffness` / `mass`: in the animation call's second argument, an object literal with no spread and exactly one member with that key, a plain non-computed property whose value is a numeric literal (the Babel plugin's eligibility rule).
   - `delay` with `init` non-null: the first argument of `withDelay`, a numeric literal.
   - `delay` with `init: null`: the right side must still be a bare `callee(...)`.
4. Compare the literal's source text with `init`; differ → `EXPRESSION_MISMATCH`.
5. Write:
   - replace the literal by byte range with the serialized number;
   - bare call + delay > 0: replace the right side with `<withDelay>(<value>, <original right-side text>)`. If the callee is a member expression (`Reanimated.withTiming`), `<withDelay>` is the same object's member (`Reanimated.withDelay`) and imports are untouched. Otherwise `<withDelay>` is the local name of an existing `withDelay` named import from `react-native-reanimated` (aliases respected), or `withDelay` added as a specifier to the module's first value import from `react-native-reanimated` (a default-only import gains `, { withDelay }`); no value import from that module → `DECLARATION_MISSING` with an explanation. Bare call + delay 0: nothing to write, `ok` with `written: "0"` and `previous: "0"`;
   - several requests in one file are spliced from the end, so earlier offsets stay valid.

Numbers are written with `String(value)` (`380`, `14.5`); clients send values already snapped to the control's `step`. A literal request whose value is not a finite number is rejected by protocol validation; values are never rounded or clamped by the workspace. Formatting outside the replaced ranges is untouched. Two requests resolving to overlapping ranges in one file (for example a delay wrap and a duration change on the same bare call) are applied together when one range contains the other: the inner literal is replaced first and the wrap is built from the updated right-side text.

## 4. Clients

- **panel-core**: `applySource(schemaId, controlIds)` includes controls carrying `literal`, sending `literal` instead of `anchor`. A new helper lists the literal-anchored controls whose current value differs from their default ("pending changes").
- **Workbench**: the Inspector of a selected animation shows **Apply to code** when any of its parameters differs from the source; the timeline toolbar shows **Apply N changes** for the whole timeline. Results appear as a notice; `EXPRESSION_MISMATCH` says the file changed and asks to reload the app.
- After a successful write, Fast Refresh re-evaluates the module and the controls re-register with the new literals as their defaults, so the change count returns to zero by itself.

## Out of scope

- Literals that are not numeric literals (`{ duration: DURATION }`), easing, `toValue`, and spring configs coming from a `spring` control (those already have RFC 0004 anchors when declared with `// @inspect`).
- Removing a `withDelay` when a delay goes back to 0 (it is written as `withDelay(0, …)`).
- Auto-apply on commit.

## Test plan

- Protocol: fixtures for a control with `literal`, a `source.apply` with a literal request, and invalid cases (both anchors, neither, literal with non-slider kind).
- Plugin: binding descriptors carry the anchor (target text, callee, parameter, init, enclosure, assignment line/column), including `init: null` for a bare call's delay.
- Runtime: controls registered by the three helpers carry `literal`.
- CLI: one test per row of the table, plus duration/spring/delay replacements, bare-call wrapping with and without an existing `withDelay` import, two requests in one file, and byte-exact output outside the replaced ranges.
- End to end on the Simulator: drag a block, Apply, the file changes, Fast Refresh, the block stays where it was and the change count is zero.
