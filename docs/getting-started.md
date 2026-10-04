# Getting Started

## Add Runtime Inspector to your app

From your React Native / Expo app root:

```bash
npx runtime-inspector init            # add --dry-run to preview the edits
```

`init` adds `@runtime-inspector/babel-plugin` to `babel.config.js` (before the Reanimated/worklets plugin, which must stay last) and wraps `metro.config.js` with `withRuntimeInspector(...)` from `@runtime-inspector/react-native/metro` (one copy of React, React Native and Reanimated; Rozenite when `WITH_ROZENITE=true`). It never runs your package manager: it prints the install command for the two packages if they are missing. Every step is idempotent; config shapes it cannot edit safely get a "manual step needed" line with the exact change.

There is nothing else to write in the app for its animations to appear on the Workbench timeline. The hooks below are for values you want to expose explicitly.

## No token to copy

`runtime-inspector dev` writes `~/.runtime-inspector/session.json` (broker url + session token, file mode 0600; `RUNTIME_INSPECTOR_HOME` overrides the folder) and removes it on exit. The Workbench and the MCP client read it when `VITE_RI_TOKEN` / `RI_TOKEN` are not set, and pick up a restarted CLI by themselves. Explicit environment variables still win.

## Working in this repository

Install dependencies:

```bash
pnpm install
```

Start Runtime Inspector:

```bash
pnpm dev
```

The CLI prints local and LAN URLs. Physical devices auto-discover the broker via Metro, so no configuration is needed.

"Apply to code" write-back resolves source anchors against the CLI's working directory, which is the app project root when you run `runtime-inspector dev` from your app. If the CLI runs from somewhere else, point it at the app root with `RUNTIME_INSPECTOR_WORKSPACE_ROOT=<path>` — this repo's root `pnpm dev` script does exactly that for the example app.

Start the example app:

```bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

If discovery fails on an unusual network, copy the printed `EXPO_PUBLIC_RI_BROKER_URL=ws://<lan-ip>:4577` value to override it explicitly:

```bash
EXPO_PUBLIC_RI_BROKER_URL=ws://<lan-ip>:4577 pnpm --filter @runtime-inspector/example-react-native-reanimated start
```

Open `http://127.0.0.1:4600`.

For Android over USB without LAN, you can keep the default emulator URL by running:

```bash
adb reverse tcp:4577 tcp:4577
```

## Runtime usage

### `// @inspect` directive (fastest path for an existing codebase)

If you already have `useSharedValue`s scattered through a codebase, the fastest way in is a comment - no import, no hook. Add `@runtime-inspector/babel-plugin` to `babel.config.js`:

```js
module.exports = {
  plugins: ["@runtime-inspector/babel-plugin", "react-native-reanimated/plugin"]
};
```

Then annotate the declaration you want to expose:

```ts
// @inspect min=8 max=48
const cardRadius = useSharedValue(28);
```

The plugin rewrites this (dev-only) into a call to `__riInspect`, which registers the value in an "auto" schema panel and publishes it — `cardRadius` is still the same shared value, transparently returned, so the rest of the component is untouched. Numeric values need `min`/`max` in the directive (same rule as `useInspector`'s bare-number rejection); `step`, `unit`, and a quoted `label="..."` are optional. In a production build (`api.env() === "production"`), the plugin does nothing and the comment stays inert.

This is the right entry point when you want one or two values exposed without touching the surrounding component. Reach for `useInspector` below when you want several related controls grouped under one panel.

### `useRuntimeValue` (one value, one line)

`useRuntimeValue(name, initial, options?)` registers a single Runtime Value directly, with no panel spec and no schema id to invent:

```ts
import { useRuntimeValue } from "@runtime-inspector/react-native";

const blur = useRuntimeValue("blur", 18, { min: 0, max: 40 });
// blur is the runtime-native mutable value - in React Native, a Reanimated
// SharedValue: use blur.value in a worklet/style, as usual.
```

- **Kind inference** is the same table as `useInspector`/`// @inspect`: number → slider (requires `min`/`max` in `options`, thrown as an actionable error otherwise), boolean → toggle, string → color, `{ damping, stiffness }` → spring, a 4-number array → bezier. Actions are declared, not inferred: passing a function throws pointing to `useAction("<name>", fn)` instead.
- **Options**: `min`, `max`, `step`, `unit`, `label`, `onChange` — `onChange` fires after the handle is written, same as `useInspector`.
- **Panel placement**: every `useRuntimeValue` call lands in the same shared "auto" schema that `// @inspect` publishes to, so scattered one-liners across components collect into a single panel with no grouping to set up. Reach for `useInspector` instead when you want a named, grouped panel.
- **Lifecycle**: registers on mount, unregisters on unmount, and republishes the shared schema (debounced) either way — unmounting removes the control from the panel. Because unmount releases the name, remounting the same component does not accumulate `name2`, `name3` suffixes; a genuine collision (two live `useRuntimeValue` calls with the same name) does get a suffix, with a dev warning, same as `// @inspect`.
- **Production**: dev-only like the rest of the SDK — in release builds the hook still returns a usable handle, it just never registers.

### `useAction` (declared triggers)

`useAction(name, handler, options?)` registers a trigger control in the same shared "auto" schema:

```ts
import { useAction } from "@runtime-inspector/react-native";

const replay = useAction("replay", () => runReplayAnimation());
// The panel renders a button. `replay` is the handler itself, unchanged.
```

Actions are declared, not inferred from a function's shape — the same rationale as the `useRuntimeValue` function-initial error above. Same lifecycle as `useRuntimeValue` (register on mount, dispose on unmount, name release, live-collision suffix + warning). Options: `label`.

### Automatic scenes and curves (no code)

With the Babel plugin on, every function in a component that starts discovered animations becomes a **scene** by itself ([RFC 0008](../rfcs/0008-automatic-motions.md)): a `function play() {}` or `const play = () => {}` / `useCallback(...)` declared in the component body, or a `useEffect` whose body only animates. It appears in the Workbench while its component is on screen (and stays listed afterwards), titled from the component and function names, and Play replays it. Shared values animated in the component are recorded as curves without `useRuntimeProbe`.

Optional comment for names, or to exclude a function:

```ts
// @scene "Product reveal" group="Store"
function play() { … }

// @scene off
function resetPose() { … }
```

The numbers of discovered animations (a timing `duration`, a spring's `damping` / `stiffness` / `mass`, a start delay) are editable in the Workbench timeline and Inspector. With `runtime-inspector dev` running, **Apply to code** writes the tuned numbers back into the source file — `withDelay(140, withTiming(0, { duration: 380 }))` becomes `withDelay(180, withTiming(0, { duration: 420 }))` — and Fast Refresh picks them up ([RFC 0007](../rfcs/0007-animation-literal-write-back.md)).

An automatic scene can be replayed while its screen is showing. To open it from elsewhere, add navigation with `defineScene("<file>:<Component>.<function>", { open, link })` or use the explicit API below.

### `useScene` (motion scenes) — explicit

A scene is a named moment of motion — the product page reveal, the like burst, the sheet opening — that any client can open: the app navigates there, waits for the screen to mount, and plays the motion ([RFC 0006](../rfcs/0006-scenes.md)). The Workbench lists scenes as a storyboard; the web panel and React Native DevTools show them as buttons; the MCP agent has `list_scenes` / `open_scene`.

Declare scenes once, at module scope, so they are listed before their screen is visited:

```ts
import { defineScenes } from "@runtime-inspector/react-native";

defineScenes({
  "product-reveal": { title: "Product reveal", group: "Store", link: "/product", open: () => router.push("/product") },
  "checkout-sheet": { title: "Checkout sheet", group: "Store", link: "/sheet" }
});
```

Bind the motion where it lives. `useScene` returns a stable function; call it for the screen's own entrance too, so an opened scene does not play twice:

```ts
const play = useScene("product-reveal", () => {
  coverOpacity.value = withTiming(1, { duration: 320 });
  titleY.value = withDelay(140, withTiming(0, { duration: 380 }));
});
useEffect(() => play(), []);
```

- **Opening**: on screen → plays now; otherwise `open()` if declared, else `Linking.openURL(link)`; then waits up to 5 s for `useScene` to mount and plays one frame later. Failures (`UNREACHABLE`, `NAVIGATION_FAILED`, `MOUNT_TIMEOUT`, `PLAY_FAILED`, `SUPERSEDED`) are reported to every client with a reason.
- **Links**: absolute links are used as is; a path is resolved with `configureScenes({ linkPrefix: "myapp://" })`, else Expo Go's `exp://host/--/path`, else the Expo development build's `scheme`. In **Expo Go** a deep link to the running project reloads the bundle, so declare `open()` for in-app navigation and keep `link` for copying and cold start.
- **Hidden screens**: navigators that keep screens mounted should pass focus, `useScene(id, play, { active: useIsFocused() })`.
- **Production**: no-op; `useScene` returns a function that calls `play`.

### `useInspector` (recommended for multiple controls)

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

`useInspector` builds the schema and handles once (on mount) and connects/disconnects the panel session across the component's lifecycle, mirroring `definePanel(...).connect()` / `.disconnect()` under the hood. It requires `react-native-reanimated` — handles are created with its `makeMutable`, and a missing install throws rather than falling back to a plain object.

Any value entry can take an `onChange` callback, fired with the newly-applied value right after the handle's `.value` is written — this covers side effects (re-running an animation, scheduling a preview) that used to need a manual `bindValue` call alongside the hook. The returned handles also expose `$targets`, a plain object with the last panel-applied value per control, so call sites don't need to keep their own ref in sync:

```ts
const card = useInspector("card-transition", {
  scale: { value: 1, min: 0.8, max: 1.2, step: 0.01, onChange: () => console.log("scale changed") }
});

// card.$targets.scale is the last value the panel applied.
```

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

`useInspector` is sugar over exactly this API — reach for it for the common case, or drop to this explicit form when you need direct control over bindings, multiple hand-wired schemas, or don't have `react-native-reanimated` installed.

## Monorepo note

If the SDK lives in the same pnpm workspace as your app (like this repo's example), make `react`, `react-native`, and `react-native-reanimated` resolve as singletons — pnpm can install a second physical copy of peer dependencies, and two Reanimated instances break shared values created by the SDK (`sv.addListener is not a function`). See `examples/react-native-reanimated/metro.config.js` for the Metro `resolveRequest` override. Apps installing the SDK from npm don't need this.

## Verification

For CI and non-interactive agent sessions, run verification with `CI=true` and keep the package commands serialized:

```bash
CI=true pnpm verify
```

On Windows, avoid running `pnpm install`, `pnpm -r test`, and `pnpm -r typecheck` in parallel against the same `node_modules`. pnpm may need to recreate the modules directory after lockfile/runtime changes; without `CI=true` it can abort because there is no TTY for the purge confirmation, and parallel installs can leave React Native packages half-linked.
