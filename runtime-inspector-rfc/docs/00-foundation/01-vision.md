# Vision

Runtime Inspector is a runtime-first development environment for tuning application behavior through an external declarative panel.

## The target experience

A developer runs a React Native app on a real device.

The app registers a panel:

```ts
definePanel({
  id: "gallery-transition",
  title: "Gallery Transition",
  groups: [
    group("Motion", [
      slider("scale", { min: 0.8, max: 1.2, step: 0.001, defaultValue: 1 }),
      slider("blur", { min: 0, max: 40, step: 0.1, defaultValue: 14 }),
      slider("opacity", { min: 0, max: 1, step: 0.01, defaultValue: 0.24 }),
      spring("spring", { defaultValue: { damping: 18, stiffness: 160, mass: 1 } }),
      bezier("easing", { defaultValue: [0.6, 0.01, 0.5, 1] })
    ])
  ]
});
```

A desktop or web panel discovers the runtime, renders the controls and sends updates live.

The animation changes on the device without hiding the app behind an internal debug UI.

When the result feels right, the developer exports a preset:

```ts
export const galleryTransitionPreset = {
  scale: 1.032,
  blur: 18.4,
  opacity: 0.28,
  spring: {
    damping: 20,
    stiffness: 148,
    mass: 1
  },
  easing: [0.62, 0.02, 0.46, 1]
};
```

## Why this matters

Mobile UI quality depends heavily on details that are difficult to tune from code alone:

- spring behavior
- gesture response
- blur and opacity balance
- shadow softness
- shader intensity
- edge fade curves
- glass distortion
- transition timing
- keyboard following
- bottom sheet friction
- scroll-linked transforms

These values are experiential. They must be adjusted while watching the real runtime.

## Product promise

Runtime Inspector should make the development loop feel like this:

```txt
Move control
See result
Adjust again
Save preset
Ship
```

not this:

```txt
Change code
Save
Refresh
Reproduce state
Judge result
Repeat
```

## Long-term direction

Runtime Inspector should become a protocol-first ecosystem:

- React Native SDK
- Web panel
- Desktop panel
- VS Code extension
- DevTools plugin
- CLI recorder
- preset library
- plugin marketplace
- support for SwiftUI, Jetpack Compose, Flutter and Web runtimes
