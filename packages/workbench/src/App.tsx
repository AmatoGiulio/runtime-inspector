import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createRoot } from "react-dom/client";
import { createPanelSession } from "@runtime-inspector/panel-core";
import type { RuntimeProbeDescriptor } from "@runtime-inspector/protocol";
import "./styles.css";

const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const panelToken =
  new URLSearchParams(window.location.search).get("token") ?? import.meta.env.VITE_RI_TOKEN;

const session = createPanelSession({
  url: brokerUrl,
  token: panelToken,
  clientId: "runtime-workbench"
});
session.connect();

interface RuntimeCaptureInfo {
  label: string;
  source: "framebuffer" | "window";
  width?: number;
  height?: number;
  frameRate?: number;
  latencyMs?: number;
  encodeMs?: number;
  decodeMs?: number;
  displaySurface?: string;
}

interface ViewportBenchmarkSamples {
  active: boolean;
  frameTimes: number[];
  encodeMs: number[];
  decodeMs: number[];
  latencyMs: number[];
}

interface ViewportBenchmarkResult {
  frames: number;
  durationMs: number;
  frameRate: number;
  frameIntervalP95Ms: number;
  encodeP95Ms: number;
  decodeP95Ms: number;
  latencyP95Ms: number;
}

function App() {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const traceEntries = Object.entries(state.traceSchemas);
  const [schemaId, setSchemaId] = useState<string>();
  const [probeId, setProbeId] = useState<string>();
  const [runtimeCapture, setRuntimeCapture] = useState<RuntimeCaptureInfo>();
  const [runtimeCaptureError, setRuntimeCaptureError] = useState<string>();
  const [simulators, setSimulators] = useState<RuntimeDesktopSimulator[]>([]);
  const [selectedSimulatorUdid, setSelectedSimulatorUdid] = useState<string>();
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [inputReady, setInputReady] = useState(false);
  const [framebufferHasFrame, setFramebufferHasFrame] = useState(false);
  const [viewportBenchmarkBusy, setViewportBenchmarkBusy] = useState(false);
  const [viewportBenchmarkResult, setViewportBenchmarkResult] =
    useState<ViewportBenchmarkResult>();
  const runtimeStreamRef = useRef<MediaStream | undefined>(undefined);
  const runtimeVideoRef = useRef<HTMLVideoElement>(null);
  const framebufferCanvasRef = useRef<HTMLCanvasElement>(null);
  const framebufferBootstrapRef = useRef<RuntimeDesktopFramebufferFrame | undefined>(undefined);
  const framebufferTimesRef = useRef<number[]>([]);
  const framebufferLatencyRef = useRef<number[]>([]);
  const framebufferEncodeRef = useRef<number[]>([]);
  const framebufferDecodeRef = useRef<number[]>([]);
  const framebufferStatsUpdateRef = useRef(0);
  const viewportBenchmarkRef = useRef<ViewportBenchmarkSamples>({
    active: false,
    frameTimes: [],
    encodeMs: [],
    decodeMs: [],
    latencyMs: []
  });
  const viewportBenchmarkTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!schemaId && traceEntries[0]) {
      setSchemaId(traceEntries[0][0]);
    }
  }, [schemaId, traceEntries]);

  useEffect(() => {
    const desktop = window.runtimeDesktop;
    if (!desktop) return;

    let cancelled = false;
    desktop
      .listSimulators()
      .then((items) => {
        if (cancelled) return;
        setSimulators(items);
        setSelectedSimulatorUdid((current) => {
          if (current && items.some((item) => item.udid === current)) return current;
          return items.find((item) => item.state === "Booted")?.udid ?? items[0]?.udid;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setRuntimeCaptureError(
          error instanceof Error ? error.message : "Could not discover iOS Simulator devices."
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const desktop = window.runtimeDesktop;
    if (!desktop) return;

    let disposed = false;
    let decoding = false;
    let pendingFrame: RuntimeDesktopFramebufferFrame | undefined;

    const drawLatestFrame = async () => {
      if (decoding || disposed) return;
      decoding = true;

      try {
        while (pendingFrame && !disposed) {
          const frame = pendingFrame;
          pendingFrame = undefined;

          const decodeStartedAt = performance.now();
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(frame.bytes)], { type: frame.mimeType })
          );

          if (disposed) {
            bitmap.close();
            break;
          }

          const canvas = framebufferCanvasRef.current;
          if (canvas) {
            if (canvas.width !== frame.width) canvas.width = frame.width;
            if (canvas.height !== frame.height) canvas.height = frame.height;
            const context = canvas.getContext("2d", { alpha: false });
            context?.drawImage(bitmap, 0, 0, frame.width, frame.height);
            setFramebufferHasFrame(true);
          }

          bitmap.close();

          const decodeMs = performance.now() - decodeStartedAt;
          pushRolling(framebufferDecodeRef.current, decodeMs);
          const latencyMs = Math.max(0, Date.now() - frame.capturedAtMs);
          pushRolling(framebufferLatencyRef.current, latencyMs);

          if (viewportBenchmarkRef.current.active) {
            viewportBenchmarkRef.current.decodeMs.push(decodeMs);
            viewportBenchmarkRef.current.latencyMs.push(latencyMs);
          }
        }
      } catch (error) {
        if (!disposed) {
          setRuntimeCaptureError(
            error instanceof Error ? error.message : "Could not decode Simulator framebuffer frame."
          );
        }
      } finally {
        decoding = false;
        if (pendingFrame && !disposed) {
          void drawLatestFrame();
        }
      }
    };

    const unsubscribeFrame = desktop.onSimulatorFramebufferFrame((frame) => {
      pendingFrame = frame;
      void drawLatestFrame();

      const times = framebufferTimesRef.current;
      times.push(frame.capturedAtMs);
      if (times.length > 60) times.shift();
      const encodeMs = frame.encodeDurationUs / 1000;
      pushRolling(framebufferEncodeRef.current, encodeMs);

      if (viewportBenchmarkRef.current.active) {
        viewportBenchmarkRef.current.frameTimes.push(frame.capturedAtMs);
        viewportBenchmarkRef.current.encodeMs.push(encodeMs);
      }

      const now = performance.now();
      const shouldUpdateStats =
        frame.sequence === 0 ||
        now - framebufferStatsUpdateRef.current >= 300;

      if (!shouldUpdateStats) return;
      framebufferStatsUpdateRef.current = now;

      const measuredFrameRate =
        times.length > 1
          ? ((times.length - 1) * 1000) / Math.max(1, times[times.length - 1] - times[0])
          : undefined;

      setRuntimeCapture((current) =>
        current?.source === "framebuffer"
          ? {
              ...current,
              width: frame.width,
              height: frame.height,
              frameRate: measuredFrameRate ?? current.frameRate,
              latencyMs: average(framebufferLatencyRef.current),
              encodeMs: average(framebufferEncodeRef.current),
              decodeMs: average(framebufferDecodeRef.current)
            }
          : current
      );
    });

    const unsubscribeError = desktop.onSimulatorFramebufferError((error) => {
      setRuntimeCaptureError(error.message);
    });

    return () => {
      disposed = true;
      pendingFrame = undefined;
      unsubscribeFrame();
      unsubscribeError();
    };
  }, []);

  useEffect(() => {
    if (runtimeCapture?.source !== "framebuffer") return;

    const frame = framebufferBootstrapRef.current;
    if (!frame) return;

    let cancelled = false;
    const animationFrame = requestAnimationFrame(() => {
      void (async () => {
        try {
          const bitmap = await createImageBitmap(
            new Blob([new Uint8Array(frame.bytes)], { type: frame.mimeType })
          );

          if (cancelled) {
            bitmap.close();
            return;
          }

          const canvas = framebufferCanvasRef.current;
          if (!canvas) {
            bitmap.close();
            return;
          }

          if (canvas.width !== frame.width) canvas.width = frame.width;
          if (canvas.height !== frame.height) canvas.height = frame.height;
          const context = canvas.getContext("2d", { alpha: false });
          context?.drawImage(bitmap, 0, 0, frame.width, frame.height);
          bitmap.close();

          framebufferBootstrapRef.current = undefined;
          framebufferTimesRef.current = [frame.capturedAtMs];
          setFramebufferHasFrame(true);
          setRuntimeCapture((current) =>
            current?.source === "framebuffer"
              ? {
                  ...current,
                  width: frame.width,
                  height: frame.height
                }
              : current
          );
        } catch (error) {
          if (!cancelled) {
            setRuntimeCaptureError(
              error instanceof Error
                ? error.message
                : "Could not decode the initial Simulator framebuffer."
            );
          }
        }
      })();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
    };
  }, [runtimeCapture?.source]);

  const probes = schemaId ? state.traceSchemas[schemaId] ?? [] : [];

  useEffect(() => {
    if (!probeId && probes[0]) {
      setProbeId(probes[0].id);
    } else if (probeId && !probes.some((probe) => probe.id === probeId)) {
      setProbeId(probes[0]?.id);
    }
  }, [probeId, probes]);

  const selectedProbe = probes.find((probe) => probe.id === probeId);
  const recording = state.recording;

  useEffect(() => {
    const video = runtimeVideoRef.current;
    if (!video) return;
    video.srcObject = runtimeStreamRef.current ?? null;
    if (runtimeStreamRef.current) {
      void video.play().catch(() => {
        // Autoplay is expected for muted local capture. A user gesture can recover if a browser blocks it.
      });
    }
  }, [runtimeCapture]);

  useEffect(() => {
    return () => {
      runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());
      runtimeStreamRef.current = undefined;
      void window.runtimeDesktop?.stopSimulatorFramebuffer();
      if (viewportBenchmarkTimerRef.current) {
        clearTimeout(viewportBenchmarkTimerRef.current);
      }
      viewportBenchmarkRef.current.active = false;
      framebufferCanvasRef.current
        ?.getContext("2d")
        ?.clearRect(
          0,
          0,
          framebufferCanvasRef.current.width,
          framebufferCanvasRef.current.height
        );
    };
  }, []);
  const isRecording = Boolean(recording && !recording.complete);

  const samples = useMemo(() => {
    if (!recording || !probeId) return [];
    return recording.samples
      .map((sample) => {
        const value = sample.values[probeId];
        return typeof value === "number" ? { t: sample.t, value } : undefined;
      })
      .filter((sample): sample is { t: number; value: number } => Boolean(sample));
  }, [recording, probeId]);

  function toggleRecording() {
    if (isRecording) {
      session.stopRecording();
      return;
    }
    if (!schemaId || !probeId) return;
    session.startRecording(schemaId, [probeId], 60);
  }

  function replay() {
    if (!schemaId) return;
    const schema = state.schemas.find((item) => item.id === schemaId);
    const replayControl = schema?.groups
      .flatMap((group) => group.controls)
      .find(
        (control) =>
          control.kind === "trigger" &&
          (control.id.toLowerCase().includes("replay") ||
            control.binding?.toLowerCase().includes("replay"))
      );
    if (replayControl) {
      session.fireTrigger(schemaId, replayControl.id);
    }
  }

  function runViewportBenchmark() {
    if (
      !schemaId ||
      runtimeCapture?.source !== "framebuffer" ||
      viewportBenchmarkBusy
    ) {
      return;
    }

    if (state.status !== "connected") {
      setRuntimeCaptureError(
        "Runtime disconnected. Start the Runtime Inspector broker, reconnect the app, then run the viewport benchmark."
      );
      return;
    }

    const schema = state.schemas.find((item) => item.id === schemaId);
    const benchmarkControl = schema?.groups
      .flatMap((group) => group.controls)
      .find(
        (control) =>
          control.kind === "trigger" &&
          (control.id.toLowerCase().includes("benchmarkviewport") ||
            control.id.toLowerCase().includes("benchmark") ||
            control.binding?.toLowerCase().includes("benchmark"))
      );

    if (!benchmarkControl) {
      setRuntimeCaptureError(
        "This runtime does not expose the deterministic viewport benchmark trigger."
      );
      return;
    }

    setRuntimeCaptureError(undefined);
    setViewportBenchmarkResult(undefined);
    setViewportBenchmarkBusy(true);
    viewportBenchmarkRef.current = {
      active: true,
      frameTimes: [],
      encodeMs: [],
      decodeMs: [],
      latencyMs: []
    };

    session.fireTrigger(schemaId, benchmarkControl.id);

    viewportBenchmarkTimerRef.current = setTimeout(() => {
      const samples = viewportBenchmarkRef.current;
      samples.active = false;
      viewportBenchmarkTimerRef.current = undefined;

      const times = samples.frameTimes;
      const durationMs =
        times.length > 1 ? times[times.length - 1] - times[0] : 0;
      const frameIntervals = times
        .slice(1)
        .map((time, index) => time - times[index])
        .filter((value) => value > 0);

      setViewportBenchmarkBusy(false);

      if (
        times.length < 2 ||
        durationMs <= 0 ||
        samples.encodeMs.length === 0
      ) {
        setRuntimeCaptureError(
          "Viewport benchmark did not receive enough live framebuffer samples."
        );
        return;
      }

      setViewportBenchmarkResult({
        frames: times.length,
        durationMs,
        frameRate: ((times.length - 1) * 1000) / durationMs,
        frameIntervalP95Ms: percentile(frameIntervals, 0.95),
        encodeP95Ms: percentile(samples.encodeMs, 0.95),
        decodeP95Ms: percentile(samples.decodeMs, 0.95),
        latencyP95Ms: percentile(samples.latencyMs, 0.95)
      });
    }, 3600);
  }

  async function attachRuntimeCapture() {
    const desktop = window.runtimeDesktop;
    setRuntimeCaptureError(undefined);
    setDesktopBusy(Boolean(desktop));

    try {
      runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());

      if (desktop) {
        const prepared = await desktop.startSimulatorFramebuffer(selectedSimulatorUdid);
        setSelectedSimulatorUdid(prepared.device.udid);
        setSimulators(await desktop.listSimulators());
        setInputReady(prepared.input.ready);
        framebufferBootstrapRef.current = prepared.bootstrapFrame;
        framebufferTimesRef.current = [];
        framebufferLatencyRef.current = [];
        framebufferEncodeRef.current = [];
        framebufferDecodeRef.current = [];
        framebufferStatsUpdateRef.current = 0;
        setViewportBenchmarkResult(undefined);
        viewportBenchmarkRef.current = {
          active: false,
          frameTimes: [],
          encodeMs: [],
          decodeMs: [],
          latencyMs: []
        };
        setFramebufferHasFrame(false);
        setRuntimeCapture({
          label: `${prepared.device.name} · ${prepared.device.runtime}`,
          source: "framebuffer"
        });
        if (!prepared.input.ready) {
          setRuntimeCaptureError(prepared.input.error ?? "Simulator HID input is unavailable.");
        }
        return;
      }

      if (!navigator.mediaDevices?.getDisplayMedia) {
        setRuntimeCaptureError("This browser does not support window capture.");
        return;
      }

      setInputReady(false);

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 60, max: 60 }
        },
        audio: false
      });

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        setRuntimeCaptureError("The selected source did not provide a video track.");
        return;
      }

      const settings = track.getSettings() as MediaTrackSettings & {
        displaySurface?: string;
      };

      runtimeStreamRef.current = stream;
      setRuntimeCapture({
        label: track.label || "Captured window",
        source: "window",
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        displaySurface: settings.displaySurface
      });

      track.onended = () => {
        runtimeStreamRef.current = undefined;
        if (runtimeVideoRef.current) {
          runtimeVideoRef.current.srcObject = null;
        }
        setRuntimeCapture(undefined);
        setInputReady(false);
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setRuntimeCaptureError("Window capture was cancelled or Screen Recording permission was denied.");
        return;
      }
      setRuntimeCaptureError(
        error instanceof Error ? error.message : "Could not attach the runtime surface."
      );
    } finally {
      setDesktopBusy(false);
    }
  }

  function detachRuntimeCapture() {
    if (runtimeCapture?.source === "framebuffer") {
      void window.runtimeDesktop?.stopSimulatorFramebuffer();
    }
    runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());
    runtimeStreamRef.current = undefined;
    if (runtimeVideoRef.current) {
      runtimeVideoRef.current.srcObject = null;
    }
    const canvas = framebufferCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setFramebufferHasFrame(false);
    framebufferBootstrapRef.current = undefined;
    framebufferTimesRef.current = [];
    framebufferLatencyRef.current = [];
    framebufferEncodeRef.current = [];
    framebufferDecodeRef.current = [];
    framebufferStatsUpdateRef.current = 0;
    if (viewportBenchmarkTimerRef.current) {
      clearTimeout(viewportBenchmarkTimerRef.current);
      viewportBenchmarkTimerRef.current = undefined;
    }
    viewportBenchmarkRef.current.active = false;
    setViewportBenchmarkBusy(false);
    setViewportBenchmarkResult(undefined);
    setRuntimeCapture(undefined);
    setRuntimeCaptureError(undefined);
    setInputReady(false);
  }

  async function retrySimulatorInput() {
    const desktop = window.runtimeDesktop;
    if (!desktop || runtimeCapture?.source !== "framebuffer") return;

    setRuntimeCaptureError(undefined);
    try {
      await desktop.prepareSimulatorInput();
      setInputReady(true);
    } catch (error) {
      setInputReady(false);
      setRuntimeCaptureError(
        error instanceof Error ? error.message : "Could not prepare native Simulator HID input."
      );
    }
  }

  function sendSimulatorPointer(
    event: ReactPointerEvent<HTMLDivElement>,
    type: "down" | "drag" | "up"
  ) {
    const desktop = window.runtimeDesktop;
    if (!desktop || !inputReady) return;

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    desktop.sendSimulatorPointer({ type, x, y });
  }

  function handleRuntimePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!window.runtimeDesktop || !inputReady) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sendSimulatorPointer(event, "down");
  }

  function handleRuntimePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!window.runtimeDesktop || !inputReady || (event.buttons & 1) === 0) return;
    event.preventDefault();
    sendSimulatorPointer(event, "drag");
  }

  function handleRuntimePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!window.runtimeDesktop || !inputReady) return;
    event.preventDefault();
    sendSimulatorPointer(event, "up");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <main className="workbench">
      <header className="topbar">
        <div className="brand">Runtime Inspector</div>
        {state.notice && <div className="notice">{state.notice}</div>}
        <div className="connection" data-status={state.status}>
          <span className="dot" />
          {state.status}
        </div>
      </header>

      <section className="workspace">
        <aside className="outline panel">
          <div className="panel-title">Outline</div>
          {traceEntries.length === 0 ? (
            <Empty text="No runtime probes yet." />
          ) : (
            traceEntries.map(([id, schemaProbes]) => (
              <div className="schema" key={id}>
                <button
                  className={id === schemaId ? "schema-button active" : "schema-button"}
                  onClick={() => {
                    setSchemaId(id);
                    setProbeId(schemaProbes[0]?.id);
                  }}
                >
                  {id}
                </button>
                {id === schemaId && (
                  <div className="probe-list">
                    {schemaProbes.map((probe) => (
                      <button
                        key={probe.id}
                        className={probe.id === probeId ? "probe active" : "probe"}
                        onClick={() => setProbeId(probe.id)}
                      >
                        <span className="probe-icon">⌁</span>
                        <span>{probe.label ?? probe.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </aside>

        <section className="runtime-stage">
          <div className="stage-toolbar">
            <div className="stage-toolbar-title">
              <span>Live Runtime</span>
              {runtimeCapture ? (
                <span className="capture-status">
                  <span className="capture-status-dot" />
                  {captureSummary(runtimeCapture)}
                </span>
              ) : window.runtimeDesktop ? (
                <span className="stage-note">Desktop adapter · iOS Simulator</span>
              ) : (
                <span className="stage-note">Browser capture · iOS Simulator</span>
              )}
            </div>

            <div className="stage-controls">
              {!runtimeCapture && window.runtimeDesktop && simulators.length > 0 ? (
                <select
                  className="simulator-select"
                  aria-label="iOS Simulator target"
                  value={selectedSimulatorUdid ?? ""}
                  onChange={(event) => setSelectedSimulatorUdid(event.target.value)}
                  disabled={desktopBusy}
                >
                  {simulators.map((simulator) => (
                    <option key={simulator.udid} value={simulator.udid}>
                      {simulator.name} · {simulator.runtime}
                      {simulator.state === "Booted" ? " · Booted" : ""}
                    </option>
                  ))}
                </select>
              ) : null}

              {runtimeCapture && window.runtimeDesktop ? (
                runtimeCapture.source === "framebuffer" ? (
                  inputReady ? (
                    <span className="input-status" title="Native Simulator HID input enabled">
                      Input on
                    </span>
                  ) : (
                    <button className="stage-action" type="button" onClick={retrySimulatorInput}>
                      Retry Input
                    </button>
                  )
                ) : (
                  <span className="input-status pending" title="Window fallback is view-only">
                    View only
                  </span>
                )
              ) : null}

              <button
                className="stage-action"
                type="button"
                onClick={runtimeCapture ? detachRuntimeCapture : attachRuntimeCapture}
                disabled={desktopBusy || (Boolean(window.runtimeDesktop) && simulators.length === 0)}
              >
                {runtimeCapture
                  ? "Detach"
                  : desktopBusy
                    ? "Launching…"
                    : window.runtimeDesktop
                      ? "Launch & Attach"
                      : "Attach Simulator"}
              </button>
            </div>
          </div>

          <div className={runtimeCapture ? "runtime-surface attached" : "runtime-surface"}>
            {runtimeCapture ? (
              runtimeCapture.source === "framebuffer" ? (
                <div
                  className={`runtime-framebuffer-shell${inputReady ? " interactive" : ""}`}
                  style={
                    runtimeCapture.width && runtimeCapture.height
                      ? { aspectRatio: String(runtimeCapture.width / runtimeCapture.height) }
                      : undefined
                  }
                  onPointerDown={handleRuntimePointerDown}
                  onPointerMove={handleRuntimePointerMove}
                  onPointerUp={handleRuntimePointerUp}
                  onPointerCancel={handleRuntimePointerUp}
                >
                  <canvas
                    ref={framebufferCanvasRef}
                    className="runtime-framebuffer"
                    aria-label="Live iOS Simulator framebuffer"
                  />
                  {!framebufferHasFrame ? (
                    <div className="framebuffer-loading">Connecting to Simulator framebuffer…</div>
                  ) : null}
                </div>
              ) : (
                <div className="runtime-video-shell">
                  <video
                    ref={runtimeVideoRef}
                    className="runtime-video"
                    autoPlay
                    muted
                    playsInline
                  />
                  <div className="runtime-video-caption">
                    <span>{runtimeCapture.label}</span>
                    <span>Window fallback · view only</span>
                  </div>
                </div>
              )
            ) : (
              <div className="device-placeholder">
                <div className="device-screen">
                  <div className="device-eyebrow">REAL RUNTIME</div>
                  <div className="device-title">
                    {window.runtimeDesktop
                      ? "Launch the iOS Simulator"
                      : "Attach the iOS Simulator"}
                  </div>
                  <div className="device-copy">
                    {window.runtimeDesktop
                      ? "Runtime Inspector boots the selected target and attaches directly to its iOS framebuffer."
                      : "Choose the Simulator window in the macOS sharing picker. Browser capture is a view-only fallback."}
                  </div>
                  <button
                    className="device-attach"
                    type="button"
                    onClick={attachRuntimeCapture}
                    disabled={desktopBusy || (Boolean(window.runtimeDesktop) && simulators.length === 0)}
                  >
                    {desktopBusy
                      ? "Launching…"
                      : window.runtimeDesktop
                        ? "Launch & Attach"
                        : "Attach Simulator"}
                  </button>
                </div>
              </div>
            )}

            {runtimeCaptureError ? (
              <div className="capture-error" role="status">
                {runtimeCaptureError}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="inspector panel">
          <div className="panel-title">Inspector</div>
          {selectedProbe ? (
            <ProbeInspector probe={selectedProbe} samples={samples} />
          ) : (
            <Empty text="Select a runtime probe." />
          )}
        </aside>
      </section>

      <section className="timeline">
        <div className="timeline-toolbar">
          <button className={isRecording ? "record active" : "record"} onClick={toggleRecording}>
            <span className="record-dot" />
            {isRecording ? "Stop" : "Record"}
          </button>
          <button className="tool-button" onClick={replay} disabled={!schemaId}>
            ▶ Replay
          </button>
          <button
            className="tool-button"
            onClick={runViewportBenchmark}
            disabled={
              !schemaId ||
              state.status !== "connected" ||
              runtimeCapture?.source !== "framebuffer" ||
              viewportBenchmarkBusy
            }
          >
            {viewportBenchmarkBusy ? "Benchmarking…" : "Benchmark viewport"}
          </button>
          <button
            className="tool-button"
            onClick={() => session.clearRecording()}
            disabled={isRecording || !recording}
          >
            Clear
          </button>
          <div className="timeline-meta">
            {viewportBenchmarkResult
              ? benchmarkSummary(viewportBenchmarkResult)
              : recording
                ? `${recording.samples.length} samples · ${recording.sampleRateHz} Hz${recording.incomplete ? " · gap" : ""}`
                : "No recording"}
          </div>
        </div>

        <div className="track">
          <div className="track-label">
            <strong>{selectedProbe?.label ?? probeId ?? "Probe"}</strong>
            <span>{selectedProbe?.unit ?? ""}</span>
          </div>
          <TraceGraph samples={samples} />
        </div>
      </section>
    </main>
  );
}

function ProbeInspector({
  probe,
  samples
}: {
  probe: RuntimeProbeDescriptor;
  samples: Array<{ t: number; value: number }>;
}) {
  const values = samples.map((sample) => sample.value);
  const latest = values.at(-1);
  const min = values.length ? Math.min(...values) : undefined;
  const max = values.length ? Math.max(...values) : undefined;

  return (
    <div className="inspector-fields">
      <Field label="Signal" value={probe.id} />
      <Field label="Type" value={probe.valueType} />
      <Field label="Unit" value={probe.unit ?? "—"} />
      <Field label="Current" value={formatValue(latest)} />
      <Field label="Min" value={formatValue(min)} />
      <Field label="Max" value={formatValue(max)} />
      <Field label="Samples" value={String(samples.length)} />
      <Field label="Measured Hz" value={measuredHz(samples)} />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function TraceGraph({ samples }: { samples: Array<{ t: number; value: number }> }) {
  if (samples.length < 2) {
    return <div className="graph-empty">Record and replay the transition to draw the trace.</div>;
  }

  const width = 1000;
  const height = 180;
  const minT = samples[0].t;
  const maxT = samples.at(-1)!.t;
  const values = samples.map((sample) => sample.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const timeSpan = Math.max(1, maxT - minT);
  const valueSpan = Math.max(0.0001, maxV - minV);

  const points = samples
    .map((sample) => {
      const x = ((sample.t - minT) / timeSpan) * width;
      const y = height - ((sample.value - minV) / valueSpan) * (height - 24) - 12;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Runtime trace">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} className="grid-line" />
        <polyline points={points} className="trace-line" />
      </svg>
      <div className="graph-range">
        <span>{formatValue(minV)}</span>
        <span>{formatTime(maxT - minT)}</span>
        <span>{formatValue(maxV)}</span>
      </div>
    </div>
  );
}

function captureSummary(capture: RuntimeCaptureInfo) {
  const size =
    capture.width && capture.height ? `${capture.width}×${capture.height}` : undefined;
  const fps = capture.frameRate ? `${capture.frameRate.toFixed(0)} fps` : undefined;
  const latency =
    capture.latencyMs !== undefined ? `${capture.latencyMs.toFixed(0)} ms` : undefined;
  const encode =
    capture.encodeMs !== undefined ? `enc ${capture.encodeMs.toFixed(1)}` : undefined;
  const decode =
    capture.decodeMs !== undefined ? `dec ${capture.decodeMs.toFixed(1)}` : undefined;
  const source = capture.source === "framebuffer" ? "direct framebuffer" : undefined;
  return [size, fps, latency, encode, decode, source].filter(Boolean).join(" · ") || "attached";
}

function pushRolling(values: number[], value: number, max = 60) {
  if (!Number.isFinite(value)) return;
  values.push(value);
  if (values.length > max) values.shift();
}

function average(values: number[]) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}


function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = percentileValue * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const fraction = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

function benchmarkSummary(result: ViewportBenchmarkResult) {
  return [
    `Bench ${result.frameRate.toFixed(1)} fps`,
    `frame p95 ${result.frameIntervalP95Ms.toFixed(1)} ms`,
    `enc p95 ${result.encodeP95Ms.toFixed(1)}`,
    `dec p95 ${result.decodeP95Ms.toFixed(1)}`,
    `lat p95 ${result.latencyP95Ms.toFixed(0)}`,
    `${result.frames} frames`
  ].join(" · ");
}

function measuredHz(samples: Array<{ t: number; value: number }>) {
  if (samples.length < 2) return "—";
  const durationMs = samples.at(-1)!.t - samples[0].t;
  if (durationMs <= 0) return "—";
  return (((samples.length - 1) * 1000) / durationMs).toFixed(1);
}

function formatValue(value: number | undefined) {
  if (value === undefined) return "—";
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
}

function formatTime(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

createRoot(document.getElementById("root")!).render(<App />);