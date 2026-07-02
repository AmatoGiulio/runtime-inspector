# Presets

Presets are the primary output of a tuning session.

## Preset format

```json
{
  "runtimeInspectorPreset": "1.0",
  "panelId": "gallery-transition",
  "name": "Soft Gallery Transition",
  "values": {
    "motion.scale": 1.032,
    "motion.blur": 18.4,
    "motion.opacity": 0.28
  }
}
```

## Export targets

- JSON
- TypeScript object
- ESM module
- clipboard
- file
- code snippet
- future: PR patch generation

## TypeScript export

```ts
export const softGalleryTransition = {
  scale: 1.032,
  blur: 18.4,
  opacity: 0.28
} as const;
```

## Preset strategy

Presets should be human-readable and stable in git.
