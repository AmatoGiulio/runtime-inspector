# Binding Engine

The binding engine maps protocol paths to runtime targets.

This is the bridge between declared controls and real behavior.

## Binding examples

```txt
motion.blur       -> Reanimated SharedValue
motion.opacity    -> React state setter
shader.noise      -> Skia uniform
theme.radius      -> design token store
layout.spacing    -> Zustand store
native.intensity  -> native module setter
```

## Requirements

- low latency
- no React re-render for high-frequency values
- type validation
- safe disposal
- hot reload resilience
- support for batch updates

## Reanimated binding

The most important MVP binding is Reanimated SharedValue.

```ts
const blur = useSharedValue(14);

slider("blur", {
  min: 0,
  max: 40,
  defaultValue: 14,
  bind: bindSharedValue(blur)
});
```

On patch:

```ts
blur.value = nextValue;
```

No component re-render is required.

## Commit vs live values

Some controls should update continuously. Others should update only on commit.

For example:

- slider: live
- text field: commit or debounced
- JSON editor: commit
- color picker: live
