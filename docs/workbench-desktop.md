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

The original implementation attempted to forward macOS mouse events to Simulator with `CGEvent.postToPid`. Manual validation on 2026-10-01 showed that this does not produce touches inside the simulated iOS app. That path is removed.

The current M3b.2 spike follows the mechanism used by Simulator-focused developer tooling instead:

- a `simctl io screenshot` provides the exact device framebuffer reference;
- the desktop adapter matches that reference inside the captured Simulator window and derives a normalized device-screen crop;
- the Workbench renders only that cropped device surface;
- pointer positions in the crop are already normalized iOS-screen coordinates;
- a persistent Objective-C helper loads Xcode's private SimulatorKit and opens a `SimDeviceLegacyHIDClient` for the selected Simulator UDID;
- down / drag / up are sent through Simulator's IndigoHID path rather than macOS mouse-event routing;
- the HID helper stays outside RIP.

### Why the implementation changed

Simulator.app does not simply forward arbitrary macOS mouse events to the iOS process. Its own input path translates desktop interaction into Simulator HID/touch events. Posting a Quartz mouse event to the Simulator process can reach Simulator chrome without becoming an iOS touch.

The private HID approach is intentionally isolated behind the device adapter. It is a developer-tool technique, not a protocol dependency.

### Structural risk

SimulatorKit / IndigoHID are private Xcode frameworks. Therefore:

- this path can break with an Xcode update;
- M3b.2 currently targets Apple Silicon;
- compatibility must be tested against supported Xcode versions;
- a slower public automation fallback (for example XCUITest/WebDriverAgent) may be needed if a stable fallback becomes a product requirement.

Reference implementations studied for this spike:

- Meta `idb` / FBSimulatorControl HID transport;
- `ios-simulator-mcp` native IndigoHID experiment.

No external implementation is vendored as a package dependency.

### M3b.2 acceptance gate

Manual validation on 2026-10-01 confirmed that the native IndigoHID path reaches the app: the embedded `TAP TEST` counter increments from Runtime Inspector. The remaining defect is crop precision: the first matcher can include part of the Simulator/device bezel, which introduces a small pointer offset.

The crop matcher is therefore required to lock onto high-information framebuffer features (status bar, Dynamic Island, app/card/button edges) rather than mostly-dark interior samples.

- Launch & Attach reports **Input on** only after the native HID client is prepared;
- the central viewport shows the device screen crop rather than Simulator chrome;
- clicking the demo `TAP TEST` in the embedded viewport increments its counter;
- holding the pointer visibly reaches `PRESSED`;
- dragging produces continuous touch motion;
- the actual Simulator window may remain behind Runtime Inspector;
- Record → Replay and the motion timeline remain unaffected.

## Packaging / TCC TODO — required before release

This is explicitly tracked, not deferred implicitly.

During the 2026-10-01 development validation, macOS attributed Screen Recording permission to the development host (VS Code) rather than a packaged Runtime Inspector identity. Before release:

- package and sign the desktop app as **Runtime Inspector**;
- ship and sign the native input helper with the app rather than compiling it in `/tmp`;
- verify Screen Recording / Screen & System Audio permission is attributed to Runtime Inspector;
- verify the native helper is correctly signed/bundled and still loads the intended Simulator private frameworks;
- provide first-run Screen Recording permission UX;
- test permission reset/relaunch/update behavior on a clean macOS account.

## Still deferred

- multi-touch;
- hardware-key forwarding;
- public/stable input fallback;
- production packaging/signing implementation.

These remain device-adapter concerns and must not leak into RIP.