# RFC 0004 — Source anchors and write-back ("Apply to code")

- Status: draft
- Author: architect session, 2026-07-17
- Affects: `babel-plugin`, `protocol` (additive), `transport-ws`, `cli` (new workspace client), `panel-core`, `panel-web`, `client-mcp` (optional tool), docs
- Breaking: no (additive: one optional control field, one new client role, one new message pair; tolerant readers ignore all three)

## Motivation

Copy-as-code closes the tuning loop by hand: tune on device, copy a snippet, paste it into the editor. The remaining friction is the paste — locating the right declaration and replacing the right expression. This RFC closes the loop mechanically: the panel gains an **Apply to code** action that rewrites the annotated declaration in the source file with the tuned value.

Prior art validating the design: Tinkerble (SwiftUI-only, github.com/edwardsanchez/Tinkerble) ships exactly this loop — a compile-time source anchor captured by a macro, AST-based re-location on apply (line numbers only as a tiebreaker), file-hash verification, and an explicit error taxonomy. Nothing in the React Native ecosystem does this today.

## Design principle: the anchor is a name, not a line number

Line numbers go stale the moment the developer edits the file. The stable identity of a declaration is **where it lives structurally**: file path + enclosing function/component chain + variable name. Line/column are carried only to disambiguate when the same name appears twice in the same scope chain. Re-location always re-parses the current file content; it never trusts recorded offsets.

## Part 1 — Babel plugin: capture the anchor

The plugin already visits the exact AST node of every `// @inspect`-annotated `useSharedValue`. It additionally embeds a `source` object into the `__riInspect` meta:

```ts
__riInspect(useSharedValue(0), "moveX", {
  min: -120, max: 120,
  source: {
    file: "src/Card.tsx",        // relative to the Babel root/cwd
    line: 42, column: 8,          // tiebreaker only
    enclosure: ["Card"],          // enclosing function/component names, outermost first
    name: "moveX",                // declared variable name
    init: "0"                     // initializer argument text as written
  }
});
```

- `file` is relativized against `state.file.opts.root ?? cwd`; absolute paths never enter the bundle.
- `init` is the exact source text of the `useSharedValue(...)` argument (generated via the node's range), used later as the safety check before overwriting.
- Dev-only like the rest of the transform; production output is unchanged.
- Second pass (same RFC, may land separately): inject the same `source` option into `useRuntimeValue(name, initial, opts)` and `useInspector` spec entries when the plugin is active, so the hook-based DX levels get write-back too. Without the plugin those controls simply have no anchor and the panel shows no Apply button — graceful degradation.

## Part 2 — Protocol: `source` on controls, `workspace` role, `source.apply`

All additive; no `RIP_VERSION` bump per the protocol-stability policy (new optional field, new message types, and a new role value that only ever appears in handshakes between same-version CLI components — the broker and the workspace client ship in the same process).

### `InspectorControl.source?: SourceAnchor` (optional field)

The runtime SDK forwards the anchor from `__riInspect` meta into the published schema. Zod: optional object, unknown-field tolerant. Panels that predate this field strip it (tolerant reader).

### New role: `workspace`

A third client role alongside `runtime` and `panel`. The workspace client has filesystem access to the project; in `runtime-inspector dev` it is the CLI process itself, connected to its own broker. The role keeps the broker dumb (route, don't interpret) and keeps the thesis intact: a future VSCode extension can be the workspace client instead, applying edits through the editor's own undo stack. Workspace clients authenticate with the session token, same as panels.

### `source.apply` (Command, panel → workspace)

```json
{
  "type": "source.apply",
  "schemaId": "auto",
  "requests": [
    { "controlId": "moveX", "anchor": { ... }, "value": 42 }
  ]
}
```

Carries the typed protocol value, not a serialized expression: the workspace owns serialization so the written syntax always matches the target context. Command family: at-most-once, never cached, never replayed.

### `source.applyResult` (Event, workspace → panel)

Per-request outcome:

```json
{
  "type": "source.applyResult",
  "schemaId": "auto",
  "results": [
    { "controlId": "moveX", "ok": true, "written": "42", "previous": "0" },
    { "controlId": "damping", "ok": false, "code": "EXPRESSION_MISMATCH" }
  ]
}
```

Error taxonomy (mirrors the validation-code pattern from `validateControlValue`):

| Code | Meaning |
| --- | --- |
| `PARSE_FAILURE` | current file no longer parses |
| `DECLARATION_MISSING` | no declaration matches name + enclosure |
| `DECLARATION_MOVED` | matches exist but none at the recorded line/column when disambiguation was needed |
| `DECLARATION_AMBIGUOUS` | multiple matches even after the line/column tiebreaker |
| `EXPRESSION_MISMATCH` | current initializer text differs from the anchor's `init` (manual edit since the schema was published) — never overwrite silently |
| `WRITE_FAILURE` | filesystem error |

`EXPRESSION_MISMATCH` is the load-bearing guard (Tinkerble's `acceptedInitializerExpressions`): the workspace only replaces an expression it can prove is the one the running app was built from. A hot-reload after the edit republishes the schema with a fresh anchor, clearing the mismatch naturally.

## Part 3 — Workspace apply procedure (CLI)

1. Read the file at `anchor.file` (resolved against the CLI's cwd — the project root by construction of `runtime-inspector dev`).
2. Parse with `@babel/parser` (same plugins config as the transform).
3. Collect candidate declarations: variable name === `anchor.name`, enclosing function/component chain === `anchor.enclosure`, initialized by a `useSharedValue` / `useRuntimeValue` call carrying the `@inspect` directive or matching shape.
4. One candidate → proceed. Multiple → filter by `anchor.line`/`column`; zero after filter → `DECLARATION_MOVED`; >1 → `DECLARATION_AMBIGUOUS`.
5. Compare the candidate's current initializer text with `anchor.init`; differ → `EXPRESSION_MISMATCH`.
6. Serialize the new value to a TS expression (shared helper, see below) and splice it by byte range — no reprint of the whole file, no formatting churn outside the replaced range.
7. Write, report `previous`/`written` in the result.

Value→expression serialization lives in `@runtime-inspector/protocol` as a pure helper (`serializeValueExpression(kind, value)`), next to value validation: it is value-shape-driven, has no session logic, and is needed by the CLI today and any other workspace client tomorrow. `panel-core`'s copy-as-code migrates to it to avoid two serializers drifting apart.

## Part 4 — Panel UX

- Controls with `source` show an **Apply to code** affordance; a schema-level **Apply all** covers every anchored control with a changed value.
- Results surface in the existing notice area; `EXPRESSION_MISMATCH` gets an actionable message ("file changed since launch — hot-reload and retry").
- Auto-apply on commit is explicitly **out of scope** for the first pass; if added later it must be an opt-in persisted preference (Tinkerble's model), never a default.

## Optional — MCP tool

`client-mcp` gains `apply_to_source` (same shape as `source.apply`), so an agent can tune and then persist the result in one loop. Rejected while the schema is stale, like the other mutating tools. May land after the core.

## Scope limits (first pass)

- `// @inspect` + `useSharedValue` only; hook-injection (`useRuntimeValue`, `useInspector`) is the documented second pass.
- No multi-root/monorepo path mapping beyond "anchor is relative to the Babel root, resolved against the CLI cwd"; a mismatch surfaces as `DECLARATION_MISSING` with the path in the message.
- No editor-integration transport (VSCode workspace client is future work enabled by the role, not part of this RFC).
- No undo stack in the CLI; `previous` in the result plus git is the undo story.

## Test plan

- Plugin: snapshot tests for the embedded `source` meta (relative path, enclosure chain, init text, tiebreaker fields); production build untouched.
- Protocol: schema fixtures for `source.apply`/`source.applyResult` and the optional `source` control field; conformance suite entries.
- CLI locator: unit tests per error code — clean apply, moved declaration (same name, new line), duplicate name in two components (ambiguity → tiebreaker), manual edit (`EXPRESSION_MISMATCH`), unparseable file, spliced output preserves surrounding formatting byte-for-byte.
- End-to-end: example app → tune slider → apply → file contains new literal → hot reload republishes schema with fresh anchor → second apply succeeds.
