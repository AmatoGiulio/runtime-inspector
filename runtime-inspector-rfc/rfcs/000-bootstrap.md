# RFC 000: Project Bootstrap

## Status

Draft

## Summary

Runtime Inspector begins as a documentation-first project. The first goal is to define a protocol and development workflow before implementing the SDK and panel.

## Decision

Create a repository organized around RFC documents, packages, examples and assets.

## Initial packages

- `@runtime-inspector/protocol`
- `@runtime-inspector/react-native`
- `@runtime-inspector/panel-web`
- `@runtime-inspector/transport-ws`
- `@runtime-inspector/cli`

## Initial MVP

A React Native app registers a panel schema. A local broker relays messages. A web panel renders controls. The app receives patches and updates Reanimated SharedValues.
