# Control Rendering

## Built-in controls

- Slider
- Toggle
- Number input
- Text input
- Select
- Segmented control
- Color picker
- Gradient editor
- Bezier editor
- Spring editor
- Vector editor
- JSON editor
- Asset picker

## Control contract

Each control receives:

```ts
type ControlRendererProps = {
  control: ControlNode;
  value: unknown;
  disabled?: boolean;
  onPatch(value: unknown): void;
  onCommit?(value: unknown): void;
};
```

## Patch behavior

Controls may emit two kinds of updates:

- live patch: while moving
- commit patch: when interaction ends

This enables recording and undo systems to treat slider drags as one operation.
