# Runtime Inspector Protocol (RIP)

Runtime Inspector Protocol is the transport-independent contract between an instrumented runtime and a client that controls it. Current version: **0.3**.

RIP is not tied to the Web panel or to WebSockets. Today the same semantic messages can be carried by:

- the local WebSocket broker used by the Web panel and MCP client;
- the Rozenite / React Native DevTools bridge used by `@runtime-inspector/panel-rozenite`.

Transport-specific lifecycle signals may exist outside RIP, but they must not redefine protocol semantics. The Rozenite `runtime-inspector:ready` generation event is one such transport-local signal; it results in existing RIP stale/re-handshake behavior rather than a new protocol message.

## Message taxonomy

| Family | Meaning | Replay/cache expectation |
| --- | --- | --- |
| **State** | “The world is like this.” | May be cached/replayed when appropriate. |
| **Command** | “Do this now.” | Must not be replayed as state. |
| **Lifecycle** | Connection/session/schema lifecycle changed. | Updates bookkeeping rather than representing a tunable value. |

Current messages:

| Message | Family | Purpose |
| --- | --- | --- |
| `handshake.hello` | Lifecycle | Identify role/client and negotiate protocol version. |
| `handshake.accept` | Lifecycle | Accept the client for the negotiated version. |
| `schema.publish` | State | Publish/replace a runtime control schema. |
| `schema.dispose` | Lifecycle | Deliberately remove a schema. |
| `control.patch` | Preview mutation | Apply an ephemeral/live value update. |
| `control.commit` | State mutation | Apply the decided/final value. |
| `control.batchPatch` | Mutation | Apply multiple values; `committed` distinguishes preview vs decided batch. |
| `control.trigger` | Command | Fire a trigger/action exactly as an action, not as value state. |
| `runtime.status` | Lifecycle | Report runtime/schema online/offline state. |
| `error` | Lifecycle/error | Report protocol/authorization/version failures. |

Protocol 0.3 intentionally separates `control.trigger` from value mutation and `control.commit` from drag/preview patches. A trigger is not a value and must not be sent through `control.patch`.

## Roles

A client identifies as either:

- `runtime` — the instrumented application publishing schemas and applying mutations/actions;
- `panel` — a human or machine client controlling the runtime.

“MCP” and “Rozenite” are not protocol roles. Both behave as clients of the same protocol semantics.

## Handshake

A client starts with:

```json
{
  "type": "handshake.hello",
  "protocolVersion": "0.3",
  "role": "panel",
  "clientId": "runtime-inspector-panel",
  "clientName": "Runtime Inspector",
  "token": "optional-transport-token"
}
```

On success:

```json
{
  "type": "handshake.accept",
  "protocolVersion": "0.3",
  "brokerId": "runtime-inspector",
  "clientId": "runtime-inspector-panel"
}
```

`brokerId` names the accepting endpoint; direct transports may use an endpoint identity such as `direct-runtime`. It does not imply that every RIP transport contains the WebSocket broker.

The WebSocket broker requires the CLI-issued session token for panel-role clients. A direct Rozenite bridge does not use the LAN broker/token because DevTools already owns the app↔panel channel.

A protocol-version mismatch is rejected with an `error` message rather than silently accepting incompatible semantics.

## Schema publication

```json
{
  "type": "schema.publish",
  "schema": {
    "id": "card-transition",
    "title": "Card Transition",
    "version": "1",
    "groups": [
      {
        "id": "motion",
        "label": "Motion",
        "controls": []
      }
    ]
  }
}
```

A schema contains groups of controls. Supported control kinds are:

- `slider`
- `toggle`
- `color`
- `bezier`
- `spring`
- `trigger`

The current Web and Rozenite renderers both support these control kinds. Older documentation that described spring/bezier rendering as a future pass is obsolete.

Publishing an existing schema id replaces/refreshes that schema for clients. Multiple schemas can be live concurrently.

## Schema disposal

```json
{
  "type": "schema.dispose",
  "schemaId": "card-transition",
  "source": "runtime"
}
```

`schema.dispose` is a deliberate lifecycle event: the runtime is saying that schema no longer exists. Clients remove it rather than retaining it as stale.

A transient runtime disconnect is different. The broker/direct transport can report `runtime.status` offline so clients keep the last known schema visible but stale/frozen until it is republished or disposed.

## Live patch

```json
{
  "type": "control.patch",
  "schemaId": "card-transition",
  "controlId": "opacity",
  "value": 0.72,
  "source": "panel",
  "timestamp": 1789387200000
}
```

`control.patch` is for live/preview mutation such as a slider drag. `panel-core` throttles high-frequency outgoing preview updates.

The runtime validates the value against the target control before applying it. Invalid values are rejected/ignored with an explicit reason; Runtime Inspector does not silently clamp or coerce them.

`control.patch` targeting a `trigger` control is invalid at the application layer. Use `control.trigger`.

## Commit

```json
{
  "type": "control.commit",
  "schemaId": "card-transition",
  "controlId": "opacity",
  "value": 0.72,
  "source": "panel",
  "timestamp": 1789387200100
}
```

`control.commit` has the same value shape and validation rules as a patch, but means: **this is the decided/final value**. Typical examples are pointer release, A/B apply, or an agent choosing a value.

The runtime applies commits through the same binding path as patches; clients can distinguish preview traffic from final state semantically.

## Batch patch

```json
{
  "type": "control.batchPatch",
  "schemaId": "card-transition",
  "source": "preset",
  "committed": true,
  "patches": [
    { "controlId": "opacity", "value": 0.72 },
    { "controlId": "enabled", "value": true }
  ]
}
```

`committed` defaults to preview semantics when omitted/false. `committed: true` marks the batch as a decided value set, as used by A/B/preset application.

Each patch may optionally carry its own `source` and `timestamp`; otherwise the batch-level values apply.

## Trigger/action

```json
{
  "type": "control.trigger",
  "schemaId": "card-transition",
  "controlId": "replay",
  "source": "panel",
  "timestamp": 1789387200200
}
```

A trigger is a command. It carries no persistent control value and must never be replayed merely because a client reconnects. Typical use: replay an animation.

## Runtime status and stale schemas

```json
{
  "type": "runtime.status",
  "online": false,
  "clientId": "runtime-card-transition",
  "schemaId": "card-transition"
}
```

Clients use runtime status to distinguish a live schema from a cached/stale schema.

Current `panel-core` behavior:

- offline schema: remains visible, marked stale, outgoing mutations/actions are blocked;
- republished schema: becomes live again and controls resume;
- disposed schema: removed deliberately.

This behavior is shared by the Web and Rozenite clients because it lives in `panel-core` rather than renderer code.

## Errors

```json
{
  "type": "error",
  "code": "VERSION_MISMATCH",
  "message": "Protocol version mismatch"
}
```

Known transports also use protocol errors for cases such as unauthorized panel connections. Consumers should use the machine-readable `code` and keep the human-readable `message` for diagnostics.

## Control schemas and value validation

### Slider

```json
{
  "id": "opacity",
  "kind": "slider",
  "label": "Opacity",
  "defaultValue": 1,
  "min": 0,
  "max": 1,
  "step": 0.01
}
```

Requires a finite numeric value inside `[min, max]`. `step` must be positive when provided.

### Toggle

Requires a boolean.

### Color

Requires a string. `format` may be `hex` or `rgba`; current protocol validation checks the value type rather than normalizing/coercing color syntax.

### Bezier

Requires exactly four finite numbers: `[x1, y1, x2, y2]`.

### Spring

Requires an object with finite `damping` and `stiffness`, plus optional finite `mass`. Optional display ranges may be supplied per field.

### Trigger

Has no `defaultValue`/persistent value. It is fired only through `control.trigger`.

Validation returns structured reasons:

- `WRONG_TYPE`
- `OUT_OF_RANGE`
- `MALFORMED_VALUE`
- `UNKNOWN_KIND`

## Wire validation

`packages/protocol` exports the Zod schemas and two parsing paths:

- `parseRIPMessage(input)` for already-decoded message objects;
- `safeParseRIPMessage(data)` for JSON/string wire payloads, returning `undefined` for invalid input.

`control.commit` is structurally required to contain a `value` field.

## Conformance

The fixtures under `packages/protocol/fixtures/` are the executable protocol contract. Protocol changes must update:

1. an RFC in `rfcs/`;
2. types/schemas;
3. conformance fixtures;
4. this document;
5. affected runtime/client tests.

See [Protocol stability](protocol-stability.md).

## Transport independence

RIP deliberately does not specify how messages move between runtime and client.

Current concrete paths:

```text
Web panel -> panel-core -> WebSocket broker -> runtime
MCP       -------------> WebSocket broker -> runtime
Rozenite  -> panel-core -> plugin bridge ----> runtime
```

The protocol should remain unchanged when adding a transport unless the product requirement truly cannot be represented by the existing State / Command / Lifecycle model. Transport convenience alone is not grounds for a protocol message.
