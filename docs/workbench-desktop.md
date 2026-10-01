    -> framed stdout stream
    -> Electron main
    -> renderer IPC
    -> coalesced canvas decode
~~~

Important properties:

- `xcrun simctl` is no longer spawned per frame;
- the main display IOSurface is discovered once and refreshed only when its surface identity changes;
- unchanged frames are skipped using the IOSurface seed;
- the native helper scales before JPEG encoding using the shared runtime framebuffer profile instead of transporting the full 1320×2868 framebuffer;
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

After the first deterministic sweep, `balanced` was promoted to the runtime profile at 560 px / JPEG quality 0.60. The official gate now requires:

- p95 encode time <= 90% of baseline;
- average payload <= 85% of baseline;
- PSNR loss <= 1.10 dB relative to baseline in the same run.

The measured sweep on the M4 Pro test host was:

| profile | p95 encode | capacity | payload | PSNR | PSNR loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline 600/0.65 | 16.04 ms | 62.3 fps | 513.5 KB | 19.41 dB | — |
| balanced 560/0.60 | 13.90 ms | 71.9 fps | 400.7 KB | 18.41 dB | 0.99 dB |
| fast 520/0.58 | 12.60 ms | 79.3 fps | 340.5 KB | 17.88 dB | 1.52 dB |
| lean 480/0.55 | 11.56 ms | 86.5 fps | 277.1 KB | 17.31 dB | 2.10 dB |

The runtime and benchmark import the same profile definition so the production transport cannot silently drift away from the benchmarked configuration.

Normal `pnpm test` also runs a small deterministic encoder fixture and verifies exact source/output dimensions, fixed JPEG payload size across repeated runs, and the native benchmark result schema. It intentionally does **not** assert wall-clock milliseconds.

This separation is deliberate:

- correctness/regression test → deterministic and CI-safe;
- performance gate → deterministic workload + relative same-machine comparison;
- live aggressive Replay → integration validation after a profile passes the benchmark.

## M3c.5 — validated SimScreen callback baseline

The persistent helper now prefers CoreSimulator's per-present `SimScreen` callbacks and retains high-frequency seed polling only as a compatibility fallback. The stream remains on the promoted balanced profile: **560 px / JPEG 0.60**.

The Workbench reports the active native source directly in the Live Runtime toolbar:

~~~text
560×1217 · 60 fps · 13 ms · enc 11.5 · dec 2.0 · SimScreen callbacks
~~~

A deterministic live viewport run on the M4 Pro host measured:

~~~text
60.4 fps · frame p95 19.3 ms · enc p95 11.5 · dec p95 2.0 · lat p95 13 ms · 215 frames
~~~

Here `lat` is capture-to-canvas latency, not HID-input-to-visual-response latency.

The preceding 500 µs seed-polling path measured 58.7 fps with the same 560/0.60 quality profile. The callback path is therefore the primary transport; seed polling remains the Xcode-compatibility fallback.