# Schema Definition

A schema describes what the panel can render.

## Panel schema

```ts
type PanelSchema = {
  id: string;
  title: string;
  description?: string;
  version?: string;
  groups: ControlGroup[];
  metadata?: Record<string, unknown>;
};
```

## Group

```ts
type ControlGroup = {
  id: string;
  title: string;
  collapsed?: boolean;
  controls: ControlNode[];
};
```

## Control node

```ts
type ControlNode =
  | SliderControl
  | ToggleControl
  | SelectControl
  | ColorControl
  | BezierControl
  | SpringControl
  | VectorControl
  | GradientControl
  | CustomControl;
```

## Slider

```ts
type SliderControl = {
  kind: "slider";
  id: string;
  label?: string;
  path: string;
  min: number;
  max: number;
  step?: number;
  defaultValue: number;
  unit?: "px" | "%" | "ms" | "deg" | "rad" | "number";
  throttleMs?: number;
};
```

## Bezier

```ts
type BezierControl = {
  kind: "bezier";
  id: string;
  path: string;
  defaultValue: [number, number, number, number];
};
```

## Spring

```ts
type SpringControl = {
  kind: "spring";
  id: string;
  path: string;
  defaultValue: {
    damping: number;
    stiffness: number;
    mass: number;
  };
};
```
