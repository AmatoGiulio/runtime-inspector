# Runtime Inspector Protocol (RIP)

The Runtime Inspector Protocol is a set of transport-independent JSON messages exchanged between a `runtime` client (an app instrumenting itself) and a `panel` client (a human or machine controller), relayed by a broker. The current transport is a local WebSocket. Current version: **0.2**.

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
| `control.patch` | Command |
| `control.batchPatch` | Command |
| `runtime.status` | Lifecycle event |
| `error` | Lifecycle event |

**Known taxonomy violation (flagged for 0.3):** `trigger` controls ("do this callback now", e.g. "replay transition") are semantically Commands, but today they are fired via `control.patch` — the same message type used for State-ish value updates (slider, toggle, color, bezier, spring). This conflates a Command with a value-patch envelope. See `rfcs/` for the proposed 0.3 fix (likely a dedicated `control.trigger` message, plus `control.commit` — see Guarantees below).

## Message catalog

### `handshake.hello`

Sent by any client to identify itself and negotiate protocol version. `role` is `"runtime"` or `"panel"`. `token` is required only for `panel`-role clients when the broker was started with a token.

```json
{
  "type": "handshake.hello",
  "protocolVersion": "0.2",
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
  "protocolVersion": "0.2",
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

`value` is untyped at the message-schema level (`unknown`) — its shape is validated against the target control's `kind` at the application layer via `isValidControlValue`, not by `ControlPatchSchema`. `source` is one of `"panel" | "runtime" | "preset"`.

### `control.batchPatch`

Multiple patches for the same schema, applied together (e.g. loading a preset).

```json
{
  "type": "control.batchPatch",
  "schemaId": "card-transition",
  "patches": [
    { "controlId": "scale", "value": 1.2 },
    { "controlId": "flip", "value": false }
  ],
  "source": "preset"
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

### `error`

Sent by the broker (or a client) to report a protocol-level failure.

```json
{
  "type": "error",
  "code": "VERSION_MISMATCH",
  "message": "Protocol version mismatch: client sent \"0.1\", broker expects \"0.2\"."
}
```

Known codes today: `INVALID_MESSAGE`, `VERSION_MISMATCH`, `UNAUTHORIZED`.

## Broker rules

Derived from `packages/transport-ws/src/index.ts`.

| Message | Forwarded to | Cached | Replayed on panel join |
| --- | --- | --- | --- |
| `handshake.hello` | broker only (not forwarded) | no | no |
| `handshake.accept` | sender only, from broker | no | no |
| `schema.publish` | opposite role (panel) | yes, keyed by sending runtime's `clientId` | yes, to every panel that completes handshake afterward |
| `control.patch` | opposite role | no | no |
| `control.batchPatch` | opposite role | no | no |
| `runtime.status` | broadcast to all panels, from broker (on runtime connect/disconnect) | no | no |
| `error` | sender only, from broker | no | no |

Additional broker behavior:

- The schema cache entry for a runtime is deleted when that runtime's socket closes, so a stale schema is never replayed after the runtime that published it disconnects.
- All non-handshake messages are relayed strictly to clients of the **opposite** role (`forwardToOppositeRole`); a message from a `panel` never reaches another `panel`, and vice versa.
- Unparseable JSON is answered with an `error` (`INVALID_MESSAGE`) and otherwise dropped — it is never forwarded.

## Compatibility policy

1. **Tolerant reader (MUST).** Clients MUST ignore message types they don't recognize and MUST ignore unknown fields on messages they do recognize. The reference implementation enforces the unknown-fields half of this for free: no schema in `packages/protocol` uses Zod's `.strict()`, so unrecognized fields are stripped, not rejected.
2. **Additive vs. semantic changes (SHOULD).** Adding a new message type or a new *optional* field to an existing message does not require a version bump. Changing the meaning or requiredness of an existing field is a semantic change and MUST bump `RIP_VERSION`.
3. **Version checked at handshake only.** `protocolVersion` is validated once, in `handshake.hello`. A mismatch gets an `error` with code `VERSION_MISMATCH` and the broker closes the socket. No other message carries or checks a version.

## Guarantees

- **Ordering:** guaranteed only per-connection (messages from a single client arrive at the broker, and are forwarded, in the order sent). No cross-connection ordering guarantee exists.
- **Commands are at-most-once.** A `control.patch` acting as a command (e.g. today's `trigger` patches) may be lost if a client disconnects mid-send during reconnect — that is acceptable. A command must never be delivered twice by the broker.
- **Drag patches are sacrificable; committed values are not.** Rapid `control.patch` messages during a drag gesture may be coalesced or dropped by any layer (client, broker, runtime) without correctness impact. A final, committed value must always arrive. Protocol 0.3 is expected to introduce an explicit `control.commit` message to distinguish the two (see `rfcs/`); today, callers must treat the last patch received before a pause as the committed value.

## Security

- `panel`-role clients may be required to present a `token` in `handshake.hello` (set via the broker's `token` option). A missing or mismatched token gets an `error` with code `UNAUTHORIZED` and the socket is closed.
- `runtime`-role clients are never token-checked. This is by design: Runtime Inspector is a LAN-only dev tool, and requiring runtime-side auth would add friction with no meaningful security benefit in that threat model.

## Clients

Any client may take the `panel` role: the web panel, a future Rozenite/DevTools plugin, a CLI, or an AI agent (e.g. via an MCP server). The protocol assumes nothing about who is on the other side; a machine-driven tuning loop (patch → observe → repeat) is a first-class use case.

`packages/client-mcp` proves this thesis: it is a stdio MCP server that connects to the broker as an ordinary `panel`-role client (same handshake, same `control.patch`/`control.batchPatch` messages as the web panel) and exposes `get_schema`, `set_control_value`, `batch_set`, and `trigger` as MCP tools, so an AI agent can read a runtime's schema and tune it exactly the way a human would from the web panel.
