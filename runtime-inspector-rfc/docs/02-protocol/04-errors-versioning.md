# Errors and Versioning

## Error message

```ts
type RIPError = {
  code: string;
  message: string;
  recoverable: boolean;
  details?: unknown;
};
```

## Error codes

- `PROTOCOL_UNSUPPORTED`
- `AUTH_REQUIRED`
- `AUTH_FAILED`
- `SCHEMA_INVALID`
- `CONTROL_NOT_FOUND`
- `PATCH_REJECTED`
- `VALUE_OUT_OF_RANGE`
- `BINDING_FAILED`
- `TRANSPORT_CLOSED`
- `INTERNAL_RUNTIME_ERROR`

## Versioning

Protocol version uses semantic versioning.

- Patch versions must be backward compatible.
- Minor versions may add message types.
- Major versions may change envelope semantics.

## Compatibility strategy

During handshake, client sends supported versions. Runtime selects the highest compatible version.

Extensions should be namespaced:

```txt
x-runtime-inspector.timeline
x-runtime-inspector.shader
x-community.mesh-gradient
```
