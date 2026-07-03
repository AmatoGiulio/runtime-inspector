# Runtime Inspector Protocol (RIP)

The Runtime Inspector Protocol is a set of transport-independent JSON messages exchanged between a `runtime` client (an app instrumenting itself) and a `panel` client (a human or machine controller), relayed by a broker. The current transport is a local WebSocket. Current version: **0.3**.

## Message taxonomy

Every message belongs to one of three families:

| Family | Meaning | Idempotent | Cacheable / replayable |
| --- | --- | --- | --- |
| **State** | "The world is like this" | Yes | Yes — last value can be cached and replayed to late joiners |
| **Command** | "Do this" | No | Never cached or replayed — re-sending has an effect each time |
| **Lifecycle event** | "This happened" | N/A | Updates caches / connection bookkeeping, not replayed itself |

Classification of every current message type:

| Message | Family |
| --- | --- |
| `handshake.hello` | Lifecycle event |
| `handshake.accept` | Lifecycle event |
| `schema.publish` | State |
| `schema.dispose` | Lifecycle event |
| `control.patch` | Command-shaped, but see below |
| `control.batchPatch` | State (see `committed` field) |
| `control.trigger` | Command |
| `control.commit` | State |
| `runtime.status` | Lifecycle event |
| `error` | Lifecycle event |

**Taxonomy violation resolved in 0.3.** Prior to 0.3, `trigger` controls ("do this callback now", e.g. "replay transition") were fired via `control.patch` — the same message type used for value updates (slider, toggle, color, bezier, spring), and drag-preview patches were indistinguishable from a human's decided value. Protocol 0.3 introduces two dedicated messages to resolve this:

- `control.trigger` (family: Command) — fires a `trigger` control. Never cached, never replayed, at-most-once delivery.
- `control.commit` (family: State) — same shape and validation as `control.patch`, but marks *the decided value* (drag release, A/B apply, agent decision) as opposed to a throttled/ephemeral preview. `control.batchPatch` gained an optional `committed` boolean (default `false`) for the same reason, rather than a separate batch-commit message.

`control.patch` targeting a `trigger` control is now invalid at the application layer: the runtime SDK ignores it with a dev warning instead of routing it to the trigger registry (that routing is now `control.trigger`'s job).

## Message catalog

### `handshake.hello`

Sent by any client to identify itself and negotiate protocol version. `role` is `"runtime"` or `"panel"`. `token` is required only for `panel`-role clients when the broker was started with a token.

```json
{
  "type": "handshake.hello",
  "protocolVersion": "0.3",
  "role": "runtime",
  "clientId": "runtime-card-transition",
  "clientName": "Card Transition Demo"
}
```

Fields: `protocolVersion` (must match broker's `RIP_VERSION` or the broker rejects with `VERSION_MISMATCH`), `role`, `clientId` (unique per client), `clientName` (optional, display only), `token` (optional, required for panels when broker enforces one).

### `handshake.accept`

Sent by the broker in response to a valid `handshake.hello`.

```json
{
  "type": "handshake.accept",
  "protocolVersion": "0.3",
  "brokerId": "broker-2f6b6f6e-9c3f-4b2a-8f2e-1a2b3c4d5e6f",
  "clientId": "panel-web-1"
}
```

### `schema.publish`

Sent by a `runtime` client to describe the controls it exposes. Contains a `PanelSchema` with groups of `InspectorControl`s. Supported control kinds: `slider`, `toggle`, `color`, `bezier`, `spring`, `trigger`.

```json
{
  "type": "schema.publish",
  "schema": {
    "id": "card-transition",
    "title": "Card Transition",
    "groups": [
      {
        "id": "motion",
        "label": "Motion",
        "controls": [
          { "id": "scale", "kind": "slider", "label": "Scale", "defaultValue": 1, "min": 0, "max": 2, "step": 0.01 },
          { "id": "flip", "kind": "toggle", "label": "Flip", "defaultValue": false },
          { "id": "accentColor", "kind": "color", "label": "Accent Color", "defaultValue": "#3366ff", "format": "hex" }
        ]
      },
      {
        "id": "easing",
        "label": "Easing",
        "controls": [
          { "id": "curve", "kind": "bezier", "label": "Curve", "defaultValue": [0.42, 0, 1, 1] },
          { "id": "bounce", "kind": "spring", "label": "Bounce", "defaultValue": { "damping": 10, "stiffness": 100 } }
        ]
      },
      {
        "id": "actions",
        "label": "Actions",
        "controls": [
          { "id": "replay", "kind": "trigger", "label": "Replay Transition", "binding": "card.replay" }
        ]
      }
    ]
  }
}
```

The web panel currently renders `slider`, `toggle`, and `color`. Other control kinds are typed in the protocol and reserved for the next implementation pass.

### `schema.dispose`

Sent by a `runtime` client from `disconnect()` (deliberate teardown: screen unmount, `definePanel` hot-reload replacement) before closing its socket, best-effort.

```json
{
  "type": "schema.dispose",
  "schemaId": "card-transition",
  "source": "runtime"
}
```

On receipt, the broker drops the cached schema for that id and forwards the message to panels, which must remove the schema from their UI. This is distinct from a silent disconnect (see `runtime.status` and Broker rules below), which keeps the cache and marks the schema stale instead.

### `control.patch`

Sent by a `panel` (or occasionally `runtime`) client to update a single control's value.

```json
{
  "type": "control.patch",
  "schemaId": "card-transition",
  "controlId": "scale",
  "value": 1.08,
  "source": "panel",
  "timestamp": 1751500000000
}
```

`value` is untyped at the message-schema level (`unknown`) — its shape is validated against the target control's `kind` at the application layer via `validateControlValue`, not by `ControlPatchSchema`. `source` is one of `"panel" | "runtime" | "preset"`.

For `slider` controls, validation also enforces the control's declared `min`/`max` bounds: a finite number outside `[min, max]` is invalid, the same as a wrong-shape value. `step` is not enforced here — rounding to a step is a UI concern, not a validity concern.

#### Validation entry point

`validateControlValue(control, value): ValidationResult` (exported from `@runtime-inspector/protocol`) is the normative validation entry point — the single source of truth for whether a value is valid for a given control, and *why* it isn't when it's not:

```ts
type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationErrorCode; message: string };

type ValidationErrorCode =
  | "WRONG_TYPE"       // wrong primitive/shape for the control's kind (e.g. a string for a toggle, a non-array for bezier)
  | "OUT_OF_RANGE"      // right shape, but a slider value outside its declared min/max
  | "MALFORMED_VALUE"   // right general shape but invalid contents (e.g. a bezier tuple of the wrong length, a spring object missing stiffness, or any non-finite number)
  | "UNKNOWN_KIND";     // the control's `kind` is not a recognized control type
```

`isValidControlValue(control, value): boolean` and `describeInvalidValue(control, value): string` remain exported as thin conveniences on top of `validateControlValue` — `isValidControlValue` returns just the `ok` boolean, and `describeInvalidValue` returns just the `message` (or a generic "valid value" string when the value is in fact valid). Prefer `validateControlValue` directly wherever the error `code` is useful (e.g. surfacing a specific error to a human or an agent) rather than only a human-readable string.

Since 0.3, a `control.patch` targeting a `trigger` control is invalid at the application layer: the runtime SDK ignores it and logs a dev warning. Use `control.trigger` instead.

### `control.trigger`

Sent by `panel`-role clients to fire a `trigger` control (family: Command). Has no `value` field — a trigger is a command, not a value update.

```json
{
  "type": "control.trigger",
  "schemaId": "card-transition",
  "controlId": "replay",
  "source": "panel",
  "timestamp": 1780000000000
}
```

The runtime SDK routes it to the `triggerRegistry` binding exactly as `control.patch` on a trigger control used to. Delivery is at-most-once: a trigger lost during reconnect is acceptable, but the broker must never deliver one twice. Never cached or replayed.

### `control.commit`

Sent by a `panel` (or occasionally `runtime`/`preset`) client to report *the decided value* of a control — drag release, A/B apply, or an agent's tuning decision — as opposed to an ephemeral drag preview. Same shape and validation as `control.patch`.

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

The runtime SDK applies it exactly like a `control.patch` (same code path). The preceding throttled drag patches remain `control.patch`; only the flushed/final value is a commit. Not cached — values live in schemas and clients, not in the broker.

### `control.batchPatch`

Multiple patches for the same schema, applied together (e.g. loading a preset or an A/B compare slot). The optional `committed` boolean (default `false`) marks the whole batch as a decided value rather than a preview — batches are already all-or-nothing, so there is no separate batch-commit message.

```json
{
  "type": "control.batchPatch",
  "schemaId": "card-transition",
  "patches": [
    { "controlId": "scale", "value": 1.2 },
    { "controlId": "flip", "value": false }
  ],
  "source": "preset",
  "committed": true
}
```

### `runtime.status`

Broadcast by the broker to all `panel` clients when a `runtime` client connects or disconnects.

```json
{
  "type": "runtime.status",
  "online": true,
  "clientId": "runtime-card-transition",
  "schemaId": "card-transition"
}
```

Since 0.3, a silent runtime disconnect (no preceding `schema.dispose`) does **not** clear the schema cache: the broker broadcasts `runtime.status` with `online: false` (and the schema id, when known) so panels can render the schema **stale** — visible but frozen — instead of disappearing. A late-joining panel is replayed the cached `schema.publish` followed by the current `runtime.status`, so it learns immediately whether the schema it just received is live or stale. This removes the Metro-reload blank-screen defect: the screen stays populated across a reload instead of going empty for its duration.

### `error`

Sent by the broker (or a client) to report a protocol-level failure.

```json
{
  "type": "error",
  "code": "VERSION_MISMATCH",
  "message": "Protocol version mismatch: client sent \"0.2\", broker expects \"0.3\"."
}
```

Known codes today: `INVALID_MESSAGE`, `VERSION_MISMATCH`, `UNAUTHORIZED`.

## Broker rules

Derived from `packages/transport-ws/src/index.ts`.

| Message | Forwarded to | Cached | Replayed on panel join |
| --- | --- | --- | --- |
| `handshake.hello` | broker only (not forwarded) | no | no |
| `handshake.accept` | sender only, from broker | no | no |
| `schema.publish` | opposite role (panel) | yes, keyed by sending runtime's `clientId` | yes, to every panel that completes handshake afterward (+ current `runtime.status` if the publishing runtime is currently disconnected — see stale replay below) |
| `schema.dispose` | opposite role (panel) | deletes the cache entry | n/a |
| `control.patch` | opposite role | no | no |
| `control.batchPatch` | opposite role | no | no |
| `control.trigger` | opposite role (runtime) | never | never |
| `control.commit` | opposite role (runtime) | no | no |
| `runtime.status` | broadcast to all panels, from broker (on runtime connect/disconnect) | no | no |
| `error` | sender only, from broker | no | no |

**Stale replay:** when a late-joining panel is replayed a cached `schema.publish` whose publishing runtime is currently disconnected, the broker follows it with the current `runtime.status` (`online: false`) so the panel immediately knows to render it stale.

Additional broker behavior:

- The schema cache entry for a runtime is deleted **only** by an explicit `schema.dispose` from that runtime, or when a different schema with the same id is republished. A silent disconnect (socket close without a preceding `schema.dispose`) keeps the cache entry — see the `runtime.status` section above.
- `control.trigger` is never cached or replayed, by design: replaying a command on late-panel-join would re-execute it, which is exactly the taxonomy violation 0.3 fixes.
- All non-handshake messages are relayed strictly to clients of the **opposite** role (`forwardToOppositeRole`); a message from a `panel` never reaches another `panel`, and vice versa.
- Unparseable JSON is answered with an `error` (`INVALID_MESSAGE`) and otherwise dropped — it is never forwarded.

## Compatibility policy

1. **Tolerant reader (MUST).** Clients MUST ignore message types they don't recognize and MUST ignore unknown fields on messages they do recognize. The reference implementation enforces the unknown-fields half of this for free: no schema in `packages/protocol` uses Zod's `.strict()`, so unrecognized fields are stripped, not rejected.
2. **Additive vs. semantic changes (SHOULD).** Adding a new message type or a new *optional* field to an existing message does not require a version bump. Changing the meaning or requiredness of an existing field is a semantic change and MUST bump `RIP_VERSION`.
3. **Version checked at handshake only.** `protocolVersion` is validated once, in `handshake.hello`. A mismatch gets an `error` with code `VERSION_MISMATCH` and the broker closes the socket. No other message carries or checks a version.

## Guarantees

- **Ordering:** guaranteed only per-connection (messages from a single client arrive at the broker, and are forwarded, in the order sent). No cross-connection ordering guarantee exists.
- **Commands are at-most-once.** `control.trigger` may be lost if a client disconnects mid-send during reconnect — that is acceptable. A command must never be delivered twice by the broker.
- **Drag patches are sacrificable; committed values are not.** Rapid `control.patch` messages during a drag gesture may be coalesced or dropped by any layer (client, broker, runtime) without correctness impact. A final, committed value must always arrive as `control.commit` (or a `control.batchPatch` with `committed: true`), which is never coalesced or dropped.
- **Slider values MUST respect the declared `min`/`max`.** A `slider` value outside its control's declared bounds is invalid. Receivers (runtime, panel, MCP client) MUST reject an out-of-range value with an explicit error — they MUST NOT silently clamp it into range.

## Security

- `panel`-role clients may be required to present a `token` in `handshake.hello` (set via the broker's `token` option). A missing or mismatched token gets an `error` with code `UNAUTHORIZED` and the socket is closed.
- `runtime`-role clients are never token-checked. This is by design: Runtime Inspector is a LAN-only dev tool, and requiring runtime-side auth would add friction with no meaningful security benefit in that threat model.

## Clients

Any client may take the `panel` role: the web panel, a future Rozenite/DevTools plugin, a CLI, or an AI agent (e.g. via an MCP server). The protocol assumes nothing about who is on the other side; a machine-driven tuning loop (patch → observe → repeat) is a first-class use case.

`packages/client-mcp` proves this thesis: it is a stdio MCP server that connects to the broker as an ordinary `panel`-role client (same handshake as the web panel) and exposes `get_schema`, `set_control_value`, `batch_set`, and `trigger` as MCP tools, so an AI agent can read a runtime's schema and tune it exactly the way a human would from the web panel. Since an agent's tool call is by definition a decided value rather than a preview, `set_control_value` sends `control.commit`, `batch_set` sends `control.batchPatch` with `committed: true`, and `trigger` sends `control.trigger`. `get_schema`'s output also reports per-schema `stale` status; when a schema is stale, the MCP client rejects `set_control_value`, `batch_set`, and `trigger` with an explicit error instead of sending controls to a disconnected runtime.
