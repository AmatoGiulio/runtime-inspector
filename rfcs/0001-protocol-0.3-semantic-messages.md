# RFC 0001 — Protocol 0.3: semantic messages

- Status: proposed
- Author: architect session, 2026-07-03
- Affects: `protocol`, `transport-ws`, `runtime-react-native`, `panel-core`, `panel-web`, `client-mcp`, docs
- Breaking: yes (single bump `0.2 → 0.3`; the broker already rejects mismatched versions with `VERSION_MISMATCH`)

## Motivation

Three semantics are currently expressed implicitly and incorrectly:

1. **Triggers are commands, not state.** Firing a trigger today sends a `control.patch` with `Date.now()` as value. A command disguised as state violates the message taxonomy (see `docs/protocol.md`): any future cache replay or patch persistence would re-execute the command. This is a latent correctness bug, not a style issue.
2. **Drag previews and decided values are indistinguishable.** During a slider drag the panel emits throttled patches; on release it flushes the final one. Consumers cannot tell "ephemeral preview" from "value the human chose". Agents (MCP) must currently process noise; undo/history and copy-as-code have no natural unit.
3. **Schema disappearance is implicit.** The broker deletes a cached schema when the publishing runtime disconnects. A Metro reload therefore strands panels on an empty screen ("No schema published") for the duration of the reload — the most visible remaining UX defect of the loop. There is no way to distinguish "screen unmounted, schema is gone" from "runtime rebooting, schema will return".

## Changes

### 1. New message: `control.trigger` (family: Command)

```json
{
  "type": "control.trigger",
  "schemaId": "card-transition",
  "controlId": "replay",
  "source": "panel",
  "timestamp": 1780000000000
}
```

- Sent by panel-role clients. No `value` field.
- Runtime SDK: routes to `triggerRegistry` exactly as the current special case does; `control.patch` targeting a `trigger` control becomes invalid and is ignored with a dev warning.
- Broker: forwards to opposite role. MUST NOT cache or replay.
- Delivery: at-most-once. A trigger lost during reconnect is acceptable; a duplicated one is not.

### 2. New message: `control.commit` (family: State)

```json
{
  "type": "control.commit",
  "schemaId": "card-transition",
  "controlId": "scale",
  "value": 1.08,
  "source": "panel",
  "timestamp": 1780000000000
}
```

- Same shape and validation as `control.patch`. Different meaning: *this is the decided value* (drag release, A/B apply, agent decision), as opposed to throttled drag previews.
- Emitted by panel-core on flush (pointer release / batch apply). The preceding drag patches remain `control.patch`.
- Runtime SDK: applies it exactly like a patch (same code path).
- Broker: forwards like a patch. Not cached (values live in schemas and clients, not in the broker).
- Contract: drag `control.patch` messages are sacrificable and coalescible by any consumer; `control.commit` messages are not.
- `control.batchPatch` gains an optional boolean field `committed` (default false) rather than a separate batch-commit message — batches are already all-or-nothing.

### 3. New message: `schema.dispose` (family: Lifecycle event)

```json
{
  "type": "schema.dispose",
  "schemaId": "card-transition",
  "source": "runtime"
}
```

- Sent by the runtime SDK from `disconnect()` (i.e. deliberate teardown: screen unmount, `definePanel` hot-reload replacement) before closing the socket, best-effort.
- Broker: on `schema.dispose`, drop the cached schema and forward the message to panels.
- Broker disconnect behavior CHANGES: when a runtime disconnects *without* disposing, the broker now KEEPS the cached schema and broadcasts `runtime.status` (existing message) so panels can render the schema as **stale** instead of empty. When the runtime reconnects and republishes, panels refresh seamlessly. This removes the Metro-reload blank screen.
- Panels: render stale state visibly (e.g. "runtime disconnected — controls frozen") and MUST NOT send patches/triggers for a stale schema.

### 4. Version bump

- `RIP_VERSION = "0.3"` in `packages/protocol`.
- No other message changes. Migration for clients in this repo is mechanical and done in the same change set.

## Broker rules after 0.3 (delta)

| Message | Forward | Cache | Replay on panel join |
|---|---|---|---|
| `control.trigger` | → runtime | never | never |
| `control.commit` | → runtime | no | no |
| `schema.dispose` | → panels | deletes entry | n/a |
| `schema.publish` (unchanged) | → panels | yes, by schema id | yes (+ stale flag if runtime currently disconnected) |

Replay of a stale schema: the broker replays the cached `schema.publish` followed by the current `runtime.status` so a late-joining panel knows it is stale.

## Impact per package

- `protocol`: three new message schemas, `committed` field on batchPatch, version bump, fixtures for every new message (valid + invalid variants).
- `transport-ws`: routing rules above; keep-on-disconnect cache behavior; tests for each rule (incl. "trigger never replayed", "dispose clears cache", "silent disconnect keeps cache + stale replay").
- `runtime-react-native`: handle `control.trigger`; reject patches on trigger controls; send `schema.dispose` on deliberate disconnect; treat `control.commit` as patch.
- `panel-core`: emit `control.trigger` for triggers, `control.commit` on flush/apply (`committed: true` on A/B batches); stale-schema state (`status` per schema) exposed to renderers; block outgoing messages for stale schemas.
- `panel-web`: render stale state; no other change (thin layer).
- `client-mcp`: `fireTrigger` sends `control.trigger`; `setValue`/`batchSet` send commits (an agent decision is by definition a commit); expose staleness in `get_schema` output.

## Explicitly deferred (with rationale)

- **`panel.capabilities` / `runtime.info`**: capability negotiation is speculative until a second heterogeneous client exists (Rozenite). Additive when needed → does not require a version bump later.
- **Hierarchical `controlPath`**: real breaking change with no current collision case. Reconsider when a panel must handle multiple runtimes concurrently. Rule until then (normative in protocol.md): control ids MUST be unique per schema.
- **Request/response RPC pattern**: not needed by any current flow; if ever needed, add `*.request`/`*.response` with `correlationId` as an additive extension.

## Test plan

- Conformance fixtures for all new messages (valid + invalid) in `packages/protocol/fixtures/`.
- Broker rule tests as listed above.
- End-to-end: broker + fake runtime + panel-core: drag → patches + one commit; trigger → callback fired exactly once; runtime silent drop → panel sees stale, schema survives; dispose → panel sees removal.
- Manual: Metro reload on device must keep the panel populated (stale → live).
