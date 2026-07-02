# Plugin System

Runtime Inspector must support custom controls without changing the core protocol.

## Plugin types

- control plugins
- panel plugins
- runtime binding plugins
- export plugins
- transport plugins

## Control plugin

A custom control extends the schema with a namespaced kind.

```json
{
  "kind": "x-runtime-inspector.shader-uniform",
  "id": "liquid.distortion",
  "path": "shader.distortion",
  "defaultValue": 0.4
}
```

The panel loads a renderer capable of handling that kind.

## Plugin resolution

If the panel does not support a custom control, it should render a fallback JSON editor or disabled placeholder.

## Built-in first

The MVP should not overbuild plugins. Start with built-ins. Design the schema so plugins can be added later.
