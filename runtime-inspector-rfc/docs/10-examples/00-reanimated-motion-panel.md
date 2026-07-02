# Example: Reanimated Motion Panel

## Goal

Tune a card transition on a real device.

## Runtime code

```tsx
import Animated, {
  useAnimatedStyle,
  useSharedValue
} from "react-native-reanimated";

import {
  definePanel,
  group,
  slider,
  spring,
  bindSharedValue
} from "@runtime-inspector/react-native";

export function CardPreview() {
  const scale = useSharedValue(1);
  const blur = useSharedValue(14);
  const opacity = useSharedValue(0.28);

  if (__DEV__) {
    definePanel({
      id: "card-transition",
      title: "Card Transition",
      groups: [
        group("Motion", [
          slider("scale", {
            path: "motion.scale",
            min: 0.8,
            max: 1.2,
            step: 0.001,
            defaultValue: 1,
            bind: bindSharedValue(scale)
          }),
          slider("blur", {
            path: "motion.blur",
            min: 0,
            max: 40,
            step: 0.1,
            defaultValue: 14,
            bind: bindSharedValue(blur)
          }),
          slider("opacity", {
            path: "motion.opacity",
            min: 0,
            max: 1,
            step: 0.01,
            defaultValue: 0.28,
            bind: bindSharedValue(opacity)
          })
        ])
      ]
    });
  }

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value
  }));

  return <Animated.View style={[{ width: 220, height: 320 }, style]} />;
}
```

## Result

The panel renders three sliders. Moving them updates the real animation state on the device.
