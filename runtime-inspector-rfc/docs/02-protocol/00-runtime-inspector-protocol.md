# Runtime Inspector Protocol

The Runtime Inspector Protocol, abbreviated RIP, is the core asset of the project.

It defines how a runtime describes editable controls and how clients update those controls.

## Design principles

1. Transport agnostic
2. Runtime agnostic
3. Declarative schemas
4. Explicit capabilities
5. Versioned messages
6. Patch-based updates
7. Extensible controls
8. Development-first security
9. Low-latency value changes
10. Exportable state

## Envelope

Every message uses a common envelope.

```ts
type RIPMessage<T = unknown> = {
  rip: "1.0";
  id?: string;
  type: string;
  sessionId?: string;
  timestamp: number;
  payload: T;
};
```

## Required message categories

- `handshake.hello`
- `handshake.accept`
- `runtime.info`
- `schema.publish`
- `values.publish`
- `control.patch`
- `control.event`
- `preset.export.request`
- `preset.export.response`
- `recording.start`
- `recording.stop`
- `error`
- `heartbeat.ping`
- `heartbeat.pong`
