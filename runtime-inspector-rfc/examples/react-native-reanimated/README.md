# React Native Reanimated Example

A minimal app that exposes a motion panel and binds sliders to Reanimated SharedValues.

## Goal

Validate the end-to-end loop:

```txt
Panel slider -> WebSocket patch -> RN runtime -> SharedValue -> animation update
```
