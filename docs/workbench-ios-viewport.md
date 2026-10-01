# Runtime Workbench M3a — iOS Simulator live viewport

M0 proved the runtime trace path on macOS on 2026-10-01:

- a real Reanimated `moveX` transition produced a continuous timing → spring curve;
- 204 samples were captured in the observed run;
- measured cadence was ~57.2 Hz against the 60 Hz target;
- no trace sequence gap was reported.

M3a validates the next independent surface: **live pixels from the real iOS Simulator inside the Workbench**.

## Why M3a uses browser window capture

The Workbench renderer is already a Vite web client. Before committing to Electron, Tauri, or a native macOS host, M3a uses the browser's window-capture path to validate:

- live Simulator pixels in the center stage;
- acceptable capture quality and latency;
- layout behavior while trace recording is active;
- the product interaction model of runtime + inspector + timeline.

The picker is intentionally user-driven. Automatic Simulator-window enumeration and pointer forwarding remain the native-shell decision for the next M3 step.

## Run

Keep the normal Runtime Inspector processes running:

~~~bash
pnpm dev
~~~

Then:

~~~bash
VITE_RI_TOKEN=<token> pnpm workbench
~~~

Open:

~~~text
http://127.0.0.1:4610
~~~

Launch the example in iOS Simulator:

~~~bash
pnpm --filter @runtime-inspector/example-react-native-reanimated ios
~~~

## Attach the Simulator

1. In Workbench press **Attach Simulator**.
2. In the macOS/Chrome sharing picker choose the **Simulator** window.
3. Confirm the live Simulator appears in the central Runtime surface.
4. Interaction remains on the actual Simulator window in M3a.
5. Record → Replay still operates independently through RIP.

The toolbar shows capture resolution and browser-reported frame rate when available.

## Permission behavior

macOS may require Screen Recording permission for the browser used to open the Workbench.

If capture is denied, enable the browser under:

~~~text
System Settings → Privacy & Security → Screen & System Audio Recording
~~~

Then restart the browser if macOS requests it.

## Acceptance gate

M3a passes when:

- the real Simulator window is visible in the Workbench;
- the stream remains live while the app animates;
- aspect ratio is preserved and the central stage does not distort the capture;
- Record → Replay still produces the runtime trace while the video is attached;
- capture does not introduce an obvious hitch in the app animation;
- Detach ends the capture cleanly.

## Deliberately deferred

- automatic Simulator discovery;
- embedding without a user picker;
- pointer/touch forwarding from the Workbench into Simulator;
- coordinate mapping;
- Accessibility permission flow;
- timestamped video/trace synchronization.

Those require a native desktop host/device adapter and are not necessary to validate the viewport concept.
