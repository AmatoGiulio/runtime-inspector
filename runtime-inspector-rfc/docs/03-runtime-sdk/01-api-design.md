# Runtime SDK API Design

## definePanel

```ts
definePanel(schema: PanelInput): PanelHandle
```

Registers a panel and returns a handle.

## PanelHandle

```ts
type PanelHandle = {
  id: string;
  update(values: Record<string, unknown>): void;
  dispose(): void;
  exportPreset(): Record<string, unknown>;
};
```

## Control builders

```ts
slider(id, options)
toggle(id, options)
select(id, options)
color(id, options)
bezier(id, options)
spring(id, options)
vector2(id, options)
vector3(id, options)
gradient(id, options)
customControl(id, options)
```

## Groups

```ts
group(title, controls, options?)
tabs(id, tabs)
section(title, controls)
```

## Bindings

```ts
bindState(setter)
bindSharedValue(sharedValue)
bindRef(ref)
bindWorklet(worklet)
bindNative(nativeHandle)
```

## Important design choice

Schema construction must be serializable. UI functions must not be sent to the panel.

Custom rendering belongs to client plugins, not runtime functions.
