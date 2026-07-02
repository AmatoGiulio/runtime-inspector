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
