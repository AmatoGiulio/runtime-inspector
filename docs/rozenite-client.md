# Rozenite client (`@runtime-inspector/client-rozenite`)

A [Rozenite](https://www.rozenite.dev) plugin that renders the Runtime
Inspector panel inside React Native DevTools, instead of (or alongside) the
standalone browser panel (`panel-web`).

## Architecture

The panel connects **directly** to the Runtime Inspector broker over
WebSocket (default `ws://127.0.0.1:4577`) with a session token, exactly like
`panel-web` does. `@runtime-inspector/panel-core`'s `createPanelSession`
handles schema replay, value patches, triggers, and `applySource`
(apply-to-code) write-back over that connection. The UI is built from
`@runtime-inspector/panel-react`'s `ControlRow` components.

`react-native.ts` (the device-side plugin entry Rozenite scaffolding expects)
is an intentional no-op: the app's `@runtime-inspector/react-native` runtime
SDK already talks to the broker on its own, so there's nothing for this
plugin to relay through Rozenite's `@rozenite/plugin-bridge` channel. The
file is kept only because some Rozenite tooling looks for it at the plugin
root; see the comment in that file for the full rationale.

This means **no protocol changes** were needed — the plugin is just another
broker client, built on the same `panel-core` + `panel-react` primitives as
`panel-web`.

## Building

```bash
pnpm --filter @runtime-inspector/client-rozenite build
```

This runs `rozenite build .`, which invokes Vite twice into `dist/`:

- the DevTools panel (`dist/devtools/panel.html` + assets, `dist/rozenite.json`)
- the `react-native.ts` entry point (`dist/react-native/*`)

`rozenite build` also updates `package.json`'s `main`/`module`/`types`/`exports`
fields to point at the built react-native entry — this is expected,
builder-managed behavior.

## Loading it in React Native DevTools

1. Start the Runtime Inspector broker: `runtime-inspector dev` (from the CLI
   package, or `pnpm dev` at the repo root). The broker prints a line like:

   ```
   Runtime Inspector DevTools:    rozenite panel -> broker ws://127.0.0.1:4577, token a1b2c3d4
   ```

   Copy the broker URL and token from that line.

2. Run `pnpm --filter @runtime-inspector/client-rozenite dev` (or set
   `ROZENITE_DEV_MODE`/use `rozenite dev .` directly) to serve the plugin to
   React Native DevTools, or install the built plugin per Rozenite's plugin
   installation docs for a production DevTools session.

3. Open the "Runtime Inspector" panel tab in React Native DevTools, paste the
   broker URL and token from step 1 into the panel's connect form, and press
   **Connect**. Both values are remembered in `localStorage` for next time.
