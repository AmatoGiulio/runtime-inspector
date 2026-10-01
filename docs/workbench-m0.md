# Runtime Workbench M0 — validation runbook

M0 validates one thing before simulator/emulator capture work begins:

~~~text
Reanimated SharedValue
→ explicit runtime probe
→ bounded 60 Hz recorder
→ RIP / WebSocket broker
→ panel-core
→ Workbench graph
~~~

## Run

From the repository root:

~~~bash
pnpm install
pnpm build
pnpm dev
~~~

pnpm dev prints a panel URL containing the session token, for example:

~~~text
http://127.0.0.1:4600?token=abcd1234
~~~

In a second terminal, pass the same token to the Workbench:

~~~bash
VITE_RI_TOKEN=abcd1234 pnpm workbench
~~~

Open:

~~~text
http://127.0.0.1:4610
~~~

In a third terminal start the example:

~~~bash
pnpm --filter @runtime-inspector/example-react-native-reanimated start
~~~

Launch iOS Simulator or Android Emulator from Expo.

## Expected M0 flow

1. Workbench Outline shows card-transition → Move X.
2. Press **Record**.
3. Press **Replay**.
4. The card animates in the running React Native app.
5. The Workbench timeline draws the real moveX samples.
6. Press **Stop** if the recording has not auto-stopped.
7. Inspector shows current/min/max/sample count.

Recordings automatically stop after 10 seconds.

## Acceptance gate

Do **not** start the embedded-device viewport milestone until these checks pass:

- trace schema arrives after either connection order (Workbench first or app first);
- a replay produces a continuous numeric curve rather than only start/end values;
- a 10 second 60 Hz recording stays bounded and completes;
- Workbench reports no sequence gap;
- replay motion does not show an obvious hitch compared with recording disabled;
- Metro reload leaves the normal Runtime Inspector schema recovery intact.

The current sampler uses JavaScript requestAnimationFrame and reads the selected SharedValue once per sampled frame. This is deliberately a spike. If it measurably harms animation smoothness, M0 has still succeeded: the protocol/timeline path is validated and the sampler must move to a UI-thread/Reanimated collector before M1.

## Out of scope in M0

- embedded iOS Simulator;
- scrcpy Android viewport;
- video/trace synchronization;
- runtime rewind;
- physical-device mirroring;
- event tracks;
- multi-probe UI.
