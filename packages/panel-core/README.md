# @runtime-inspector/panel-core

Framework-agnostic client session state and protocol behavior for [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector). Shared by the web and React Native DevTools panels to keep connection, schemas, patches, comparison slots, and export behavior consistent.

This is a **building-block package**, not a ready-made UI. For a React Native app, use [@runtime-inspector/react-native](https://www.npmjs.com/package/@runtime-inspector/react-native) and the CLI or Rozenite panel.

## Install

~~~bash
npm install @runtime-inspector/panel-core@alpha
~~~

## API surface

- `createPanelSession(options)`: create a session using an injected WebSocket-like transport or socket factory.
- `listScenes(state)`: derive scene entries from panel state.
- `createTypeScriptPreset(schema, values)`: export current control values as TypeScript.
- `coerceOptionalSpringValue` and `coerceOptionalBezierValue`: control-value helpers.

The session handles schema caching, connection and stale state, throttled live patches, final commits, triggers, A/B comparison, and compatible protocol message handling.

A host app provides the transport and renders controls. The [web panel](https://github.com/AmatoGiulio/runtime-inspector/tree/main/packages/panel-web) and [Rozenite panel](https://github.com/AmatoGiulio/runtime-inspector/tree/main/packages/panel-rozenite) show the intended integrations.

## Links

[Repository](https://github.com/AmatoGiulio/runtime-inspector) · [Protocol](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/protocol.md) · [Architecture and status](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/implementation-status.md)

**Status:** alpha, APIs may change. MIT license.
