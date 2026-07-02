# Protocol

The Runtime Inspector Protocol is JSON over a transport. The current transport is local WebSocket, but the messages are transport-independent.

## Handshake

Clients identify as `runtime` or `panel`.

```json
{
  "type": "handshake.hello",
  "protocolVersion": "0.1",
  "role": "runtime",
  "clientId": "runtime-card-transition"
}
```

The broker responds with `handshake.accept`.

### Version enforcement

The broker rejects a `handshake.hello` whose `protocolVersion` does not match the broker's `RIP_VERSION`. It sends an `error` message with code `VERSION_MISMATCH` (including both versions in the human-readable `message`) and then closes the socket without registering the client.

### Panel token

`handshake.hello` accepts an optional `token` field. When the broker is started with a `token` (dev-grade protection for LAN use), any `panel`-role hello must include a matching `token` or the broker responds with an `error` message (code `UNAUTHORIZED`) and closes the socket. The `runtime` role is never token-checked, so devices stay zero-config.

## Schema

The runtime publishes a `PanelSchema`.

Supported MVP controls:

- `slider`
- `toggle`
- `color`
- `bezier`
- `spring`
- `trigger`: invokes a callback registered in the runtime (e.g. "replay transition"), so tuning sessions can re-run an animation from the panel.

The web panel currently renders `slider`, `toggle`, and `color`. Other controls are typed in the protocol and reserved for the next implementation pass.

## Schema replay

The broker caches the last `schema.publish` per runtime and replays it to `panel`-role clients that connect later. Connection order and panel refreshes never strand a panel without a schema.

## Patches

The panel sends a `control.patch`:

```json
{
  "type": "control.patch",
  "schemaId": "card-transition",
  "controlId": "scale",
  "value": 1.08,
  "source": "panel"
}
```

Batch updates use `control.batchPatch`.

## Presets

`PresetExport` is a stable JSON shape for exporting values:

```json
{
  "schemaId": "card-transition",
  "name": "Card Transition Preset",
  "exportedAt": "2026-07-02T00:00:00.000Z",
  "values": {
    "scale": 1.08
  }
}
```

Presets are also the basis for two planned features:

- **Copy as code**: clients turn current values into paste-ready code (e.g. `withSpring(x, { damping: 14, stiffness: 180 })`), so tuned values end up in the codebase rather than dying in the panel.
- **A/B compare**: two named value sets that a client can switch between instantly while re-triggering an animation.

## Clients

Any client may take the `panel` role: the web panel, a future Rozenite/DevTools plugin, a CLI, or an AI agent (e.g. via an MCP server). The protocol assumes nothing about who is on the other side; a machine-driven tuning loop (patch → observe → repeat) is a first-class use case.
