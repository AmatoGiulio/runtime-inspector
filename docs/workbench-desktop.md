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

- a `simctl io screenshot` provides the exact device framebuffer aspect;
- the desktop adapter reads Simulator's Accessibility `AXGroup` bounds for the actual device-screen region and normalizes those bounds against the Simulator window;
- the Workbench renders only that deterministic device surface;
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

The first visual/template crop matcher was rejected after it mis-identified a top/status-bar region and produced a badly zoomed viewport. It has been removed. Crop now comes from Simulator Accessibility geometry, with full-window capture as the safe fallback if geometry is unavailable.

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

## M3c decision — direct Simulator framebuffer

The `simctl io recordVideo` help on Xcode 26.3 was checked manually on 2026-10-01. It records a QuickTime movie to a file or URL and only finalizes after SIGINT; unlike `screenshot`, it does not advertise `-`/stdout streaming. It is therefore not the live viewport primitive.

The window-crop experiments are closed. Simulator window geometry is not the iOS framebuffer and produced incorrect crops/mapping.

The next Runtime surface must read the Simulator display directly:

~~~text
CoreSimulator display
    -> IOSurface framebuffer
    -> RuntimeSurface
~~~

Input remains a separate native HID channel:

~~~text
Workbench pointer
    -> normalized framebuffer coordinates
    -> Simulator HID
~~~

The existing full Simulator-window capture remains only as a safe visual fallback while M3c is implemented. It must not be treated as the final viewport or used for coordinate mapping.

Meta FBSimulatorControl is the implementation reference for this direction: it exposes the booted Simulator framebuffer as an IOSurface and supports live frame delivery. Runtime Inspector should keep this behind `IOSSimulatorAdapter` so private-Xcode compatibility does not leak into RIP or the Workbench renderer.

## M3c.0 — exact framebuffer proof

Before implementing the final IOSurface stream, the desktop adapter now has an exact-framebuffer proof path using:

~~~text
simctl io <udid> screenshot --type jpeg --mask ignored -
~~~

The command is polled by the Electron main process and the resulting framebuffer frames are pushed to the renderer over IPC. This is intentionally a temporary validation transport:

- pixels are the exact iOS framebuffer, not the Simulator window;
- there is no crop, bezel, toolbar, or window-coordinate mapping;
- normalized pointer coordinates map directly to the framebuffer and therefore to the already-validated Simulator HID path;
- Screen Recording permission is not required for this direct path;
- target cadence is currently 15 fps and actual cadence is measured in the Workbench.

This is **not** the final performance architecture. Spawning `simctl` for every frame is expected to be slower and more CPU-heavy than the target product.

### M3c.1 target

Replace the screenshot poll with one persistent native adapter:

~~~text
CoreSimulator
  -> main display IOSurface
  -> persistent frame callback / surface
  -> RuntimeSurface
~~~

The Workbench API and HID coordinate semantics should remain the same, so this upgrade is a transport/performance change rather than another UI rewrite.

### M3c.0 validation result

Manual validation on 2026-10-01 confirmed:

- the direct framebuffer shows only the iOS screen;
- embedded HID taps reach the app correctly;
- framebuffer-normalized input coordinates are correct;
- the screenshot-per-frame proof runs at only ~9 fps in the observed run.

The performance result is expected from spawning `simctl`, encoding a JPEG, copying it through IPC, creating a Blob URL, decoding it, and replacing the renderer image for every frame. M3c.0 is therefore architecture proof only and must not be optimized further.

M3c.1 must replace the entire per-frame process/encode/decode loop with one persistent CoreSimulator framebuffer stream.

## M3c.1 — persistent IOSurface stream

Implemented on `feat/runtime-workbench-desktop`, pending local performance validation.

The `simctl screenshot` per-frame proof is replaced by one long-lived native helper:

~~~text
CoreSimulator device
    -> main display IOSurface
    -> persistent native process
    -> 60 Hz surface polling
    -> downscaled JPEG frame
    -> framed stdout stream
    -> Electron main
    -> renderer IPC
    -> coalesced canvas decode
~~~

Important properties:

- `xcrun simctl` is no longer spawned per frame;
- the main display IOSurface is discovered once and refreshed only when its surface identity changes;
- unchanged frames are skipped using the IOSurface seed;
- the native helper scales before JPEG encoding (currently 600 px wide, quality 0.65) to match the actual Workbench viewport instead of transporting the full 1320×2868 framebuffer;
- the renderer coalesces incoming frames and decodes into a canvas instead of replacing a React `<img>` / Blob URL every frame;
- HID remains independent and uses normalized framebuffer coordinates.

This is the first product-shaped live transport. If its measured motion cadence still falls materially below 60 Hz, the next optimization is not another screenshot path: replace JPEG with a persistent VideoToolbox H.264 stream while retaining the same IOSurface source and HID mapping.

### M3c.1 startup surface priming

Manual validation exposed one Xcode 26.3 lifecycle detail: the private CoreSimulator display surface can remain unpublished until the Simulator has produced its first present. Touching the real Simulator window caused the IOSurface stream to become available, which proved the persistent path itself was correct but left a bad first-attach UX.

The desktop adapter now handles this automatically:

- after boot, it takes exactly one direct `simctl io screenshot` as a startup prime;
- this is not used as the steady-state stream;
- the one-shot capture forces/observes the initial display presentation before the persistent IOSurface helper resolves the render surface;
- Simulator.app is opened with `open -g` so attaching should not steal focus from Runtime Inspector.

The steady-state transport remains the persistent IOSurface helper.

### M3c.1 bootstrap race fix

A second startup issue was isolated after the first priming pass. The one-shot bootstrap frame and the first persistent IOSurface frame could both arrive over Electron IPC before React had mounted the framebuffer canvas. Those frames were valid but had nowhere to render, so the Workbench stayed on `Connecting…` until the next real display change (for example a button press in Simulator).

The bootstrap frame is now returned as part of the start IPC response and retained by the renderer until the framebuffer canvas has mounted. It is drawn on the next animation frame, after which the persistent IOSurface stream owns subsequent updates.

Expected startup behavior: the iOS screen appears immediately after **Launch & Attach**, without touching the external Simulator window.

### M3c.1 cold-start validation

Manual validation on 2026-10-01 confirmed that the deferred bootstrap frame fixes the first-render race: after **Launch & Attach**, the iOS framebuffer appears in Runtime Inspector without any interaction with the external Simulator window. Native HID input remains active from the embedded viewport.

### M3c.1 performance instrumentation

The persistent framebuffer transport now carries timing metadata per frame so the Workbench can measure the live path instead of judging it only by eye.

Each native frame includes:

- wall-clock capture timestamp taken immediately before IOSurface read/encode;
- native JPEG encode duration;
- sequence number and encoded dimensions.

The renderer measures:

- motion-frame cadence from native capture timestamps;
- end-to-end capture → canvas latency;
- native encode cost;
- browser JPEG decode + canvas draw cost.

The Live Runtime toolbar reports a rolling window in the form:

~~~text
600×1304 · 58 fps · 22 ms · enc 5.4 · dec 1.7 · direct framebuffer
~~~

Because the IOSurface stream intentionally skips unchanged surface seeds, the FPS value represents cadence while the screen is changing, not an idle heartbeat. These numbers are the decision gate for whether M3c.1 MJPEG is sufficient or whether the same IOSurface adapter should move to persistent VideoToolbox H.264.

## M3c.2 — deterministic encoder benchmark

Encoder tuning must not be driven by ad-hoc Replay runs alone.

The Workbench now includes a deterministic native benchmark workload that exercises the **same** `RIEncodeSurfaceJPEG` path used by the live IOSurface stream:

~~~bash
pnpm benchmark:framebuffer
~~~

The fixture is fixed and reproducible:

- synthetic IOSurface: 1320×2868;
- deterministic BGRA pixel pattern;
- fixed warm-up count;
- fixed measured iteration count;
- three rounds per profile by default;
- the same native resize + ImageIO JPEG path as production.

Default profiles:

| profile | width | JPEG quality |
| --- | ---: | ---: |
| baseline | 600 | 0.65 |
| balanced | 560 | 0.60 |
| fast | 520 | 0.58 |
| lean | 480 | 0.55 |

The benchmark reports median-of-rounds p50/p95 encode time, p95 theoretical encode capacity, average payload size, and relative deltas from `baseline`.

Wall-clock time itself is not deterministic across machines. The **workload is deterministic**. Performance acceptance therefore uses a same-run relative gate rather than putting an absolute M4-Pro number into the normal unit-test suite:

~~~bash
pnpm benchmark:framebuffer:gate
~~~

The initial gate requires the `balanced` profile to use no more than 90% of baseline p95 encode time and no more than 100% of baseline payload bytes. The gate can be tightened after the first benchmark result.

Normal `pnpm test` also runs a small deterministic encoder fixture and verifies exact source/output dimensions, fixed JPEG payload size across repeated runs, and the native benchmark result schema. It intentionally does **not** assert wall-clock milliseconds.

This separation is deliberate:

- correctness/regression test → deterministic and CI-safe;
- performance gate → deterministic workload + relative same-machine comparison;
- live aggressive Replay → integration validation after a profile passes the benchmark.
