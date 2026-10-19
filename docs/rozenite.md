# Rozenite / React Native DevTools client

Status: **implemented; validated in React Native DevTools on the iOS Simulator**, twice:

- 2026-09-27, from this repository (Expo Go, SDK 52): multi-schema reception, live tuning visible in the app, and DevTools reconnection after an app reload.
- 2026-10-19, from the packed npm tarball in a fresh `create-expo-app` project (Expo SDK 58, React Native 0.88, React 19.3, Reanimated 4.7, Expo Go 58 on an iOS 26.3 Simulator, `@rozenite/metro` 2.5.0, Node 22): see [Validation](#validation).

A physical-device DevTools run and Android are still outstanding.

Runtime Inspector remains protocol-first. Rozenite is a client and transport host, not a replacement for the Runtime Inspector Protocol (RIP) or `panel-core`.

## Architecture

```text
React Native DevTools
  Runtime Inspector panel
          |
          v
      panel-core
          |
  RozenitePanelSocket
          |
 @rozenite/plugin-bridge
          |
   react-native.ts
          |
attachRuntimeInspectorProtocolClient
          |
 existing runtime sessions / bindings
          |
 SharedValue / bindValue / bindTrigger
```

RIP messages cross the Rozenite bridge unchanged. `schema.publish`, `schema.dispose`, `control.patch`, `control.commit`, `control.batchPatch`, `control.trigger`, `runtime.status`, handshake messages, and protocol errors retain their existing meaning and validation.

No protocol change was required for this client.

## Why the direct Rozenite bridge

The first implementation does **not** connect the DevTools panel back to Runtime Inspector's WebSocket broker.

Rozenite already provides an official bidirectional channel between the DevTools panel and code running in the React Native application. Using that channel directly has three concrete advantages:

1. React Native DevTools does not need the Runtime Inspector CLI, LAN address, QR discovery, or broker session token merely to control the app it is already debugging.
2. RIP stays transport-independent: the same semantic messages are carried by either the WebSocket broker or Rozenite.
3. `panel-core` remains the single implementation of client/session behavior. The Rozenite package adapts its bridge to the existing `WebSocketLike` / `createSocket` seam rather than copying schema/value/A-B/export logic.

The WebSocket broker remains the correct path for the Web panel and MCP client. This is intentionally not a broker replacement.

## Runtime generation / reload handling

Rozenite adds one **transport-local** event, `runtime-inspector:ready`, carrying the RIP version and a runtime generation id. It is not a RIP message and does not change the protocol.

When the device-side Rozenite entry is recreated after a reload, the panel adapter:

1. marks schemas known from the previous runtime generation offline through existing `runtime.status` semantics;
2. replays the panel handshake;
3. receives the currently active schemas again;
4. lets `panel-core` revive republished schemas while keeping schemas that did not return visible-but-stale.

This preserves the existing stale-schema model rather than creating a Rozenite-specific lifecycle model.

## Supported client behavior

The panel uses `panel-core` for:

- multiple schemas;
- cached values;
- stale-schema protection;
- throttled `control.patch` updates;
- final `control.commit` updates;
- `control.trigger` actions;
- A/B save/apply;
- copy-as-TypeScript export.

The renderer supports:

- slider;
- toggle;
- color;
- trigger/action;
- spring;
- bezier.

## Using it in an app

The panel is published as `@runtime-inspector/panel-rozenite@alpha`. It needs the SDK (`@runtime-inspector/react-native`, a peer dependency) and Rozenite's Metro integration.

1. Install the packages from the app root:

   ```bash
   npm install @runtime-inspector/react-native@alpha @runtime-inspector/panel-rozenite@alpha
   npm install --save-dev @rozenite/metro
   ```

   With npm 10 (the version bundled with Node 22), `npm install --save-dev @rozenite/metro` stops with `Cannot read properties of null (reading 'edgesOut')`, also in an Expo app without Runtime Inspector. npm 11 installs it: `npx npm@11 install --save-dev @rozenite/metro`. Do not work around it with `--legacy-peer-deps`: in an Expo 58 app that removes `react-native-worklets`, which Reanimated 4 needs, and Metro then fails with `Cannot find module 'react-native-worklets/plugin'`.

2. Use `withRuntimeInspector` in `metro.config.js` (`npx runtime-inspector init` writes it):

   ```js
   const { getDefaultConfig } = require("expo/metro-config");
   const { withRuntimeInspector } = require("@runtime-inspector/react-native/metro");
   module.exports = withRuntimeInspector(getDefaultConfig(__dirname));
   ```

   With `WITH_ROZENITE=true` (or `withRuntimeInspector(config, { rozenite: true })`) it applies `withRozenite` with this plugin and loads the device side of the bridge before the app: imports of `@runtime-inspector/react-native` resolve to a small entry (`rozenite-entry.js`) that re-exports the SDK and loads the panel, and that entry runs before the main module. No import in the app is needed. Without Rozenite the panel is not bundled at all. It warns when Rozenite is requested but `@rozenite/metro` or the panel package does not resolve.

3. Start Metro with `WITH_ROZENITE=true npx expo start`, open React Native DevTools (`j` in the Metro terminal) and select **Rozenite → Runtime Inspector**. Rozenite 2.5 first shows a notice about its unified plugin layout; dismiss it.

No broker, CLI or token is involved. Declarations are unchanged — `useRuntimeValue`, `useAction`, `useInspector` and `// @inspect` appear in DevTools exactly as in the web panel. The app does not mirror values into a Rozenite API. Metro still logs the SDK's one-time "Could not reach a Runtime Inspector broker" warning when `runtime-inspector dev` is not running; with Rozenite alone that is expected.

Do not set `WITH_ROZENITE` for release builds. The device side only starts in development (`__DEV__`), but a production export made with `WITH_ROZENITE=true` still contains the bridge code; one made without it contains none.

### Reloading the app in Expo Go

In Expo Go 58 a full reload (Metro's `r`) creates a new debugger target. An open DevTools window stays on the old one without a disconnection notice: its Console stops receiving logs and the Runtime Inspector panel keeps the previous controls, but changes no longer reach the app. Reopen DevTools (`j`) after a reload. Fast Refresh does not create a new target and needs nothing. Terminating the app shows DevTools' own **Reconnect DevTools** dialog, which works.

In this repository the example is already wired:

```bash
pnpm install
pnpm build
pnpm --filter @runtime-inspector/example-react-native-reanimated start:rozenite
```

## Rendering

The panel is the shared DialKit `InspectorPanel` (see [DialKit rendering](dialkit.md)), identical to the web panel except that **Apply to code** is hidden: the direct bridge has no `workspace` client to write files. Use the web panel for write-back; the MCP client has no write-back tool.

The web panel and DevTools can run at the same time: start `npx runtime-inspector dev` as well, and the app talks to both. Each panel keeps its own copy of the values, so a change made in one does not appear in the other until the app republishes its schema (for example after Fast Refresh). **Apply to code** in the web panel writes the web panel's values: set the value you want to keep there before applying.

## Validation

Automated tests use Rozenite's official `@rozenite/testing` in-memory channel and the actual `getRozeniteDevToolsClient` API. Coverage includes:

- multi-schema reception;
- patch;
- commit;
- trigger;
- the panel's first `handshake.hello` sent before the device side listens;
- runtime generation replacement / re-handshake;
- stale-schema protection;
- direct runtime schema replay and disposal;
- protocol version mismatch.

The graphical path — React Native DevTools + Metro + Rozenite + the example app — was first exercised manually on the iOS simulator (2026-09-27). That run found and fixed two integration gaps: the example never imported the plugin (so the device bridge never started), and broker discovery logged a warning per connection attempt when only Rozenite was in use. Discovery now warns once per process and backs off after two failed cycles.

### npm tarball in a new Expo 58 app (2026-10-19)

The `pnpm pack` tarball of `@runtime-inspector/panel-rozenite` was installed into a fresh `create-expo-app` project outside the monorepo, next to the published `@runtime-inspector/react-native@0.1.0-alpha.1`, `babel-plugin` and `cli` (`npx runtime-inspector init`) and `@rozenite/metro` 2.5.0. Metro ran with `WITH_ROZENITE=true`; DevTools was the frontend URL Metro serves for the app (the one `j` opens), loaded in a Chromium browser. Verified:

- the tarball contains only `dist`, `package.json` and the license; its dependencies resolve from npm (`@runtime-inspector/protocol`, `@rozenite/plugin-bridge` 2.4.0, peer `@runtime-inspector/react-native`);
- Rozenite loads the plugin, and the panel appears under **Rozenite → Runtime Inspector**;
- the panel lists an `// @inspect` value, a `useRuntimeValue` spring and a `useAction` trigger;
- moving the spring's damping from 14 to 44.5 in the panel changed the spring the app used on its next `withSpring` (logged in the app); the `// @inspect` radius visibly changed the sheet; the panel's trigger ran the app's action;
- opening DevTools after the app had started, three times in a row, including right after a cold Metro start;
- reopening DevTools after a reload, with tuning reaching the new runtime;
- with `npx runtime-inspector dev` also running and DevTools open: **Apply to code** in the web panel rewrote `useSharedValue({ damping: 14, … })` to `damping: 24.5` in `App.tsx`; after the Fast Refresh, DevTools showed 24.5 and its next change (43.5) still reached the app; a damping change made only in DevTools was not shown by the web panel;
- `npm publish --dry-run` of the tarball.

After publishing, `@runtime-inspector/panel-rozenite@alpha` was installed from the registry (with npm 11) into another fresh Expo SDK 58 app: Rozenite loaded the plugin, the panel listed the app's controls, and a damping change (14 → 33) reached the app.

That run found one bug, fixed in this package: the panel sends `handshake.hello` as soon as it mounts, and if the device side was not listening yet the hello was lost and the panel stayed on "Waiting for the app" (seen once out of four openings). The panel now repeats the hello when the runtime announces its first generation, not only when the generation changes; a repeated hello is accepted again and replays the schemas.

Not verified: Android, a physical device, the `@rozenite/metro` 2.4.0 host with Expo 58, pnpm and yarn consumers, bare React Native apps, and the standalone DevTools window that `j` opens (the same frontend was loaded in a browser instead).

Operational note: React Native 0.76 (the example app) accepts one debugger connection per app. Another CDP client (for example an agent reloading via CDP) disconnects DevTools; use **Reconnect DevTools** afterwards. React Native 0.88 reports support for several debuggers, and an agent's CDP connection did not disconnect DevTools in the 2026-10-19 run, but a reload requested over CDP in Expo Go failed with `"main" has not been registered` (a known Expo Go issue in this project, not specific to Rozenite). If DevTools is opened by hand in a browser, open it on the same host as the inspector WebSocket (`127.0.0.1` vs `localhost`) or Metro closes the connection.

## Architectural note

`panel-core` currently exposes a transport seam named in WebSocket terms (`WebSocketLike`, `createSocket`). Rozenite can use it cleanly, so this integration does not justify a refactor by itself. If a third non-WebSocket client exposes meaningful friction, renaming/extracting a more generic transport interface would then be evidence-driven rather than speculative.
