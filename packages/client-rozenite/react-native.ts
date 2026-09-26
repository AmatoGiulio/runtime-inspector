/**
 * React Native DevTools Plugin Entry Point (device side) — intentional no-op.
 *
 * Rozenite plugins normally use this file to run code inside the inspected
 * app and talk to the DevTools panel over `@rozenite/plugin-bridge`. Runtime
 * Inspector doesn't need that channel: the app's `@runtime-inspector/react-native`
 * SDK already connects directly to the Runtime Inspector broker (a local
 * WebSocket server started by `runtime-inspector dev`), and the panel
 * (`src/panel.tsx`) also connects to that same broker directly, using
 * `@runtime-inspector/panel-core`'s `createPanelSession`. Schema, values,
 * patches, triggers, and source write-back all flow over that broker
 * connection — the plugin-bridge round-trip through this device-side file
 * would be redundant.
 *
 * This file is kept only because some Rozenite tooling (auto-discovery,
 * `rozenite generate` scaffolding expectations) looks for a
 * `react-native.ts` entry point at the plugin root. It intentionally does
 * nothing.
 */
export const useDevTools = () => {
  // No-op: see file header. Runtime Inspector's device SDK and DevTools
  // panel both talk to the broker directly, bypassing the plugin bridge.
};
