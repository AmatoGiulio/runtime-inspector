# Runtime State

The runtime maintains three separate stores.

## Schema store

Contains immutable or rarely changing panel definitions.

## Value store

Contains current values for all registered control paths.

## Binding store

Maps a control path to a runtime target.

```txt
motion.blur -> SharedValue<number>
motion.scale -> SharedValue<number>
theme.background -> Zustand setter
shader.intensity -> native uniform
```

## Why separate stores

Schema changes are rare.
Value changes are frequent.
Binding changes are runtime-specific.

Separating them avoids unnecessary schema broadcasts and keeps live patches cheap.
