# @runtime-inspector/panel-rozenite

The [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector) panel inside **React Native DevTools**, powered by Rozenite. Tune controls in the running React Native app using the same protocol and panel logic as the web client.

## Install

From your Expo / React Native app:

~~~bash
npm install @runtime-inspector/react-native@alpha @runtime-inspector/panel-rozenite@alpha
npm install --save-dev @rozenite/metro
~~~

Integrate Runtime Inspector with Metro:

~~~js
// metro.config.js (Expo)
const { getDefaultConfig } = require("expo/metro-config");
const { withRuntimeInspector } = require("@runtime-inspector/react-native/metro");

module.exports = withRuntimeInspector(getDefaultConfig(__dirname));
~~~

Start Metro with Rozenite enabled:

~~~bash
WITH_ROZENITE=true npx expo start
~~~

Open React Native DevTools (`j` in the Expo terminal), then **Rozenite → Runtime Inspector**. No WebSocket broker, CLI, or session token is needed to tune through this panel.

Controls come from the SDK's `useInspector`, `useRuntimeValue`, `useAction`, and Babel `// @inspect` integration. This panel does **not** support **Apply to code**, which is available through the separate web panel.

**Important:** only set `WITH_ROZENITE=true` for development. Expo Go full reloads may require reopening DevTools to connect to the new debugger target. Android and physical-device behavior are not yet fully validated. Consult the setup guide for known npm / Rozenite version-specific issues.

## Links

[Full Rozenite guide](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/rozenite.md) · [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [Repository](https://github.com/AmatoGiulio/runtime-inspector)

**Status:** alpha, APIs may change. MIT license.
