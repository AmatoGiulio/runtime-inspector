# System Overview

Runtime Inspector is split into four primary layers.

```txt
Target Runtime
    |
Runtime SDK
    |
Runtime Inspector Protocol
    |
Transport
    |
Client / Panel Renderer
```

## Target Runtime

The application where behavior actually runs.

The first target runtime is React Native.

## Runtime SDK

A small development-only library installed in the app. It exposes APIs for:

- declaring panels
- registering controls
- binding controls to runtime values
- receiving patches
- exporting presets
- publishing runtime metadata

## Protocol

The protocol defines all messages exchanged between runtime and client.

It is independent from React Native and independent from WebSocket.

## Transport

Transport moves protocol messages.

Initial transport: local WebSocket.

Future transports:

- Metro bridge
- USB
- ADB reverse
- Bonjour discovery
- TCP
- cloud relay for remote teams

## Client / Panel Renderer

A UI that renders declared controls.

First client: React Web panel.

Future clients:

- desktop app
- VS Code extension
- Chrome DevTools panel
- Expo DevTools plugin
- CLI
