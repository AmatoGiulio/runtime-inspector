# Patch System

Patches update values without resending the entire schema.

## Single patch

```json
{
  "rip": "1.0",
  "type": "control.patch",
  "sessionId": "ses_123",
  "timestamp": 1720000000200,
  "payload": {
    "panelId": "gallery-transition",
    "path": "motion.blur",
    "value": 18.4,
    "source": "user"
  }
}
```

## Batch patch

```json
{
  "rip": "1.0",
  "type": "control.patch.batch",
  "sessionId": "ses_123",
  "timestamp": 1720000000200,
  "payload": {
    "panelId": "gallery-transition",
    "patches": [
      { "path": "motion.scale", "value": 1.032 },
      { "path": "motion.opacity", "value": 0.28 }
    ]
  }
}
```

## Patch rules

- Patches are path-based.
- Values must match the schema type.
- Runtime may clamp values.
- Runtime may reject unsafe values.
- Client should throttle high-frequency controls.
- Runtime should apply patches without React re-render when possible.

## Recommended throttle

- slider: 16 ms to 32 ms
- color picker: 16 ms to 50 ms
- text input: debounce 150 ms
- curve editor: 16 ms to 32 ms
