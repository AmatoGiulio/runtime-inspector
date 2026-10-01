# Runtime Workbench M3b — desktop shell + iOS Simulator adapter

M3a proved that a real Simulator window and RIP motion traces can coexist in the same Workbench. M3b removes the browser sharing-picker dependency and begins the actual desktop product surface.

## Scope

The desktop spike uses:

- Electron 44 as the current shell;
- the existing Vite/React Workbench as the renderer;
- a context-isolated preload bridge;
- `xcrun simctl` for installed-device discovery and boot;
- Electron `desktopCapturer` for automatic Simulator-window discovery;
- Electron's display-media request handler to attach the selected source without a browser picker.

Electron is a shell decision for the spike, not a protocol dependency. RIP, `panel-core`, recording, and the Workbench renderer remain independent.

## Run

Install after switching to the desktop branch:

~~~bash
pnpm install
~~~

Start the Runtime Inspector broker as usual:

~~~bash
pnpm dev
~~~

Copy the emitted session token, then launch the desktop Workbench:

~~~bash
VITE_RI_TOKEN=<token> pnpm workbench:desktop
~~~

The Electron main process starts the Workbench Vite renderer internally on port 4610.

## Expected flow

1. The Workbench lists available iOS Simulator devices from `simctl`.
2. A booted device is selected first when one exists; otherwise the newest available runtime is selected.
3. Press **Launch & Attach**.
4. Runtime Inspector boots the selected Simulator if necessary.
5. Runtime Inspector opens the Simulator app.
6. The desktop adapter finds the matching Simulator window.
7. The renderer receives that source directly; no Chrome/macOS sharing picker is shown.
8. The live Simulator appears in the Runtime surface.
9. RIP Record → Replay continues to draw the motion trace independently.

## Architecture

~~~text
Electron main
├── Simulator adapter
│   ├── simctl list
│   ├── simctl boot
│   ├── bootstatus
│   └── open Simulator
├── desktopCapturer
│   └── selected Simulator window
└── preload IPC
      ↓
React Workbench
├── Runtime surface
├── Outline
├── Inspector
└── Timeline
      ↓
panel-core / RIP
~~~

Pixels and runtime semantics deliberately remain separate channels.

## Security boundary

The renderer keeps:

- `contextIsolation: true`;
- `nodeIntegration: false`;
- `sandbox: true`.

Only the narrow Simulator operations required by the Workbench are exposed through the preload bridge.

## M3b.1 acceptance gate

- desktop app opens with one command;
- installed iOS simulators populate the target selector;
- an already-booted target can attach without a picker;
- a shutdown target can boot and then attach;
- live video remains active during Record → Replay;
- no regression in RIP/timeline behavior;
- browser M3a remains usable as a fallback.

## Deferred to M3b.2

- pointer/touch forwarding from Runtime surface to Simulator;
- exact device-screen crop instead of the whole Simulator window;
- coordinate transforms;
- Accessibility permission UX;
- multi-touch and hardware-key forwarding;
- production packaging/signing.

Those belong to the native input/capture adapter and must not leak into RIP.
