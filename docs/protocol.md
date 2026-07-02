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

## Schema

The runtime publishes a `PanelSchema`.

Supported MVP controls:

- `slider`
- `toggle`
- `color`
- `bezier`
- `spring`

The web panel currently renders `slider`, `toggle`, and `color`. Other controls are typed in the protocol and reserved for the next implementation pass.

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
