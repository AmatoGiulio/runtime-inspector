# Example: Liquid Glass / Shader Panel

## Goal

Expose shader parameters for live tuning.

## Controls

- distortion
- blur
- refraction
- chromatic aberration
- highlight opacity
- noise amount
- corner radius

## Example schema

```ts
definePanel({
  id: "liquid-glass",
  title: "Liquid Glass",
  groups: [
    group("Optics", [
      slider("distortion", { min: 0, max: 1, step: 0.001, defaultValue: 0.24 }),
      slider("refraction", { min: 0, max: 2, step: 0.01, defaultValue: 0.8 }),
      slider("blur", { min: 0, max: 40, step: 0.1, defaultValue: 18 })
    ]),
    group("Surface", [
      slider("radius", { min: 0, max: 64, step: 1, defaultValue: 24 }),
      slider("highlight", { min: 0, max: 1, step: 0.01, defaultValue: 0.36 }),
      color("tint", { defaultValue: "rgba(255,255,255,0.18)" })
    ])
  ]
});
```
