# React Native Runtime SDK

The first implementation target is React Native.

## Package

```txt
@runtime-inspector/react-native
```

## Primary API

```ts
import {
  definePanel,
  group,
  slider,
  toggle,
  color,
  bezier,
  spring,
  bindSharedValue
} from "@runtime-inspector/react-native";
```

## Example

```ts
const blur = useSharedValue(14);
const scale = useSharedValue(1);

definePanel({
  id: "gallery-transition",
  title: "Gallery Transition",
  groups: [
    group("Motion", [
      slider("scale", {
        min: 0.8,
        max: 1.2,
        step: 0.001,
        defaultValue: 1,
        bind: bindSharedValue(scale)
      }),
      slider("blur", {
        min: 0,
        max: 40,
        step: 0.1,
        defaultValue: 14,
        bind: bindSharedValue(blur)
      })
    ])
  ]
});
```

## Development only

The SDK should be inactive in production by default.

```ts
if (__DEV__) {
  RuntimeInspector.start();
}
```

## Responsibilities

The SDK must:

- register schemas
- store current values
- receive patches
- validate patches
- update bindings
- expose runtime metadata
- export presets
- dispose resources on reload
