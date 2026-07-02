# Panel Renderer

The panel renderer is a client that interprets Runtime Inspector schemas.

The first renderer should be Web, because it is fastest to build, easiest to inspect and can later become a desktop app through Tauri or Electron.

## Responsibilities

- connect to runtime
- perform handshake
- receive schemas
- render groups and controls
- send patches
- display current values
- record sessions
- export presets
- show connection status
- support plugin controls

## UI principles

The panel should feel closer to Figma, Linear and developer tools than to an admin dashboard.

Key characteristics:

- dense but readable
- collapsible groups
- numeric input beside sliders
- keyboard modifiers
- reset buttons
- copy preset button
- history
- search controls
- pin important controls
- split view for multiple panels

## Layout

```txt
Top bar
  Runtime selector
  Connection state
  Preset actions

Sidebar
  Panel list
  Search
  Recent panels

Inspector
  Groups
  Controls
  Plugin widgets

Footer
  Latency
  FPS indicator
  Last patch
```
