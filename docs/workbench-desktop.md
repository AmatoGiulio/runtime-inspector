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

## M3b.2 — interactive viewport

The desktop adapter now includes the first pointer-forwarding implementation:

- the Electron capture source id is resolved to the underlying macOS window id;
- the Workbench maps pointer coordinates to normalized capture coordinates;
- a small persistent Swift helper resolves the Simulator window bounds and owner PID through Core Graphics;
- left-button down / drag / up are emitted with `CGEvent` and posted directly to the Simulator process;
- the renderer exposes an explicit **Enable Input** action;
- Accessibility permission is checked before forwarding;
- pointer streaming stays outside RIP.

The Swift helper is compiled once into the temporary Runtime Inspector development directory and reused for the session. Production packaging should ship/sign the helper rather than compile it at runtime.

### M3b.2 acceptance gate

- **Enable Input** causes the macOS Accessibility permission flow when required;
- clicking inside the embedded Simulator performs the corresponding Simulator tap;
- dragging in the embedded viewport produces a continuous drag in Simulator;
- input still works when the actual Simulator window is behind the Workbench;
- pointer coordinates remain aligned after moving the Simulator window;
- Record → Replay and the motion timeline remain unaffected.

## Packaging / TCC TODO — required before release

This is explicitly tracked, not deferred implicitly.

During the 2026-10-01 development validation, macOS attributed Screen Recording permission to the development host (VS Code) rather than a packaged Runtime Inspector identity. Before release:

- package and sign the desktop app as **Runtime Inspector**;
- ship and sign the native input helper with the app rather than compiling it in `/tmp`;
- verify Screen Recording / Screen & System Audio permission is attributed to Runtime Inspector;
- verify Accessibility permission used for input forwarding is attributed to Runtime Inspector (or its correctly signed helper, depending on final helper architecture);
- provide first-run permission UX and deep links/instructions for both privacy categories;
- test permission reset/relaunch/update behavior on a clean macOS account.

## Still deferred

- exact device-screen crop instead of the whole Simulator window;
- multi-touch;
- hardware-key forwarding;
- production packaging/signing implementation.

These remain device-adapter concerns and must not leak into RIP.