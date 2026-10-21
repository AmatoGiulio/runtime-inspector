# @runtime-inspector/react-native

Development-time React Native SDK for [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector). Expose live values, actions, and supported Reanimated animations to an external inspector panel without repeatedly rebuilding to fine-tune them.

## Get started (Expo / React Native)

Install the SDK and developer tools in your **app**, then run the locally installed CLI:

~~~bash
npm install @runtime-inspector/react-native@alpha
npm install --save-dev @runtime-inspector/babel-plugin@alpha @runtime-inspector/cli@alpha
npx runtime-inspector init
npx runtime-inspector dev
~~~

Start your app separately (for Expo: `npx expo start`) and open the panel URL printed by the CLI. `init --dry-run` previews the Babel and Metro changes before writing them.

## Expose a value

~~~tsx
import { useRuntimeValue } from "@runtime-inspector/react-native";

function Card() {
  const radius = useRuntimeValue("cardRadius", 24, {
    min: 8,
    max: 48,
    step: 1
  });

  // Use radius.value like a Reanimated SharedValue.
  return null;
}
~~~

For multiple grouped controls use `useInspector`; for a button that can replay an interaction use `useAction`. For an existing Reanimated `useSharedValue`, the Babel plugin also accepts `// @inspect min=8 max=48` directly above its declaration.

The SDK exports the Metro integration from `@runtime-inspector/react-native/metro`. `runtime-inspector init` configures `withRuntimeInspector` automatically where it can do so safely.

## React Native DevTools instead of the web panel

You can also use [@runtime-inspector/panel-rozenite](https://www.npmjs.com/package/@runtime-inspector/panel-rozenite) with Rozenite. This path does not need the broker or CLI just to tune values; **Apply to code** remains a web-panel feature.

## Important alpha limitations

- Intended for **development**, not production monitoring or remote access.
- Motion discovery covers supported Reanimated patterns, not every worklet or gesture callback.
- Reanimated 4 spring defaults differ from Reanimated 3; declare `mass` explicitly for springs you tune.
- The broker is for trusted development networks only. Treat panel URLs containing tokens as secrets.

## Links

[Full getting started guide](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [React Native DevTools setup](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/rozenite.md) · [Known limitations](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/implementation-status.md)

**Status:** alpha, APIs may change. MIT license.
