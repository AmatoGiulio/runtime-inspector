# Getting Started

Install dependencies:

```bash
pnpm install
```

Start Runtime Inspector:

```bash
pnpm dev
```

The CLI prints local and LAN URLs. Physical devices auto-discover the broker via Metro, so no configuration is needed:

```bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

If discovery fails on an unusual network, copy the printed `EXPO_PUBLIC_RI_BROKER_URL=ws://<lan-ip>:4577` value to override it explicitly:

```bash
EXPO_PUBLIC_RI_BROKER_URL=ws://<lan-ip>:4577 pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

Open `http://127.0.0.1:4578`.

For Android over USB without LAN, you can keep the default emulator URL by running:

```bash
adb reverse tcp:4577 tcp:4577
```

## Runtime usage

### `useInspector` (recommended)

`useInspector` infers the control kind from the shape of each spec value and returns a mutable `SharedValue`-like handle per key — no manual schema, no manual bindings:

```ts
import { useInspector } from "@runtime-inspector/react-native";

function Card() {
  const card = useInspector("card-transition", {
    scale: { value: 1, min: 0.8, max: 1.2, step: 0.01 }
  });

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: card.scale.value }]
  }));

  // ...
}
```

Spec value shape decides the control kind:

| Spec value | Control |
| --- | --- |
| `{ value, min, max, step?, unit?, label? }` | slider |
| `boolean` | toggle |
| `string` | color |
| `{ damping, stiffness, mass? }` | spring |
| `[x1, y1, x2, y2]` (4 numbers) | bezier |
| `() => void` | trigger |

A bare `number` is rejected — sliders always need an explicit range. The control id and binding are the spec key; the label defaults to the key split into words (`moveX` → `"Move X"`), or the explicit `label` field.

`useInspector` builds the schema and handles once (on mount) and connects/disconnects the panel session across the component's lifecycle, mirroring `definePanel(...).connect()` / `.disconnect()` under the hood.

### Explicit API (advanced)

For direct control over bindings, side effects triggered by patches, or wiring multiple schemas by hand, use the lower-level building blocks directly:

```ts
import { bindSharedValue, definePanel, group, slider } from "@runtime-inspector/react-native";

bindSharedValue("card.scale", scale);

const panel = definePanel({
  id: "card-transition",
  title: "Card Transition",
  groups: [
    group({
      id: "motion",
      label: "Motion",
      controls: [
        slider({
          id: "scale",
          label: "Scale",
          min: 0.8,
          max: 1.2,
          step: 0.01,
          defaultValue: 1,
          binding: "card.scale"
        })
      ]
    })
  ]
});

panel.connect();
```

`useInspector` is sugar over exactly this API — reach for it when a binding needs a JS-side effect (e.g. re-running an animation, updating a ref) beyond writing directly to a `SharedValue`.
