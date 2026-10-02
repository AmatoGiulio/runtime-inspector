import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createRoot } from "react-dom/client";
import {
  createPanelSession,
  type RuntimeAnimationTrace
} from "@runtime-inspector/panel-core";
import type {
  RuntimeProbeDescriptor,
  SpringValue
} from "@runtime-inspector/protocol";
import { AnimationInspector } from "./AnimationInspector";
import { AnimationTimeline } from "./AnimationTimeline";
import { ControlInspector } from "./ControlInspector";
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
  const schemaIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...state.schemas.map((schema) => schema.id),
          ...Object.keys(state.traceSchemas)
        ])
      ),
    [state.schemas, state.traceSchemas]
  );
  const [schemaId, setSchemaId] = useState<string>();
  const [probeId, setProbeId] = useState<string>();
  const [selectedControlId, setSelectedControlId] = useState<string>();
  const [selectedAnimationId, setSelectedAnimationId] = useState<string>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [inspectorMode, setInspectorMode] =
    useState<"probe" | "control" | "animation">("probe");
  const [runtimeCapture, setRuntimeCapture] = useState<RuntimeCaptureInfo>();
  const [runtimeCaptureError, setRuntimeCaptureError] = useState<string>();
  const [simulators, setSimulators] = useState<RuntimeDesktopSimulator[]>([]);
  const [selectedSimulatorUdid, setSelectedSimulatorUdid] = useState<string>();
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [inputReady, setInputReady] = useState(false);
  const [framebufferHasFrame, setFramebufferHasFrame] = useState(false);
  const [framebufferFrameSource, setFramebufferFrameSource] = useState<string>();
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
  const replayAnimationBaselineRef = useRef<Record<string, number>>({});

  useEffect(() => {
    if (schemaId || !schemaIds[0]) return;

    const firstSchemaId = schemaIds[0];
    const firstProbe = state.traceSchemas[firstSchemaId]?.[0];
    const firstControl = state.schemas
      .find((schema) => schema.id === firstSchemaId)
      ?.groups.flatMap((group) => group.controls)[0];

    setSchemaId(firstSchemaId);
    if (firstProbe) {
      setProbeId(firstProbe.id);
      setInspectorMode("probe");
    } else if (firstControl) {
      setSelectedControlId(firstControl.id);
      setInspectorMode("control");
    }
  }, [schemaId, schemaIds, state.schemas, state.traceSchemas]);

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

    const unsubscribeStatus = desktop.onSimulatorFramebufferStatus((status) => {
      if (status.frameSource) {
        setFramebufferFrameSource(status.frameSource);
      }
    });

    const unsubscribeError = desktop.onSimulatorFramebufferError((error) => {
      setRuntimeCaptureError(error.message);
    });

    return () => {
      disposed = true;
      pendingFrame = undefined;
      unsubscribeFrame();
      unsubscribeStatus();
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
  const selectedControlSchema = state.schemas.find((schema) => schema.id === schemaId);
  const selectedControl = selectedControlSchema?.groups
    .flatMap((group) => group.controls)
    .find((control) => control.id === selectedControlId);
  const selectedControlValue =
    schemaId && selectedControl ? state.values[schemaId]?.[selectedControl.id] : undefined;
  const selectedSchemaStale = schemaId ? Boolean(state.staleSchemaIds[schemaId]) : false;
  const recording = state.recording;
  const schemaAnimations = state.runtimeAnimations.filter(
    (animation) => !schemaId || animation.schemaId === schemaId
  );
  const replayBaseline =
    schemaId !== undefined ? replayAnimationBaselineRef.current[schemaId] : undefined;
  const detectedAnimations =
    replayBaseline !== undefined
      ? schemaAnimations.slice(replayBaseline)
      : latestAnimationBurst(schemaAnimations);
  const detectedAnimationOriginMs =
    detectedAnimations.length > 0
      ? Math.min(
          ...detectedAnimations.map((animation) => animation.startedAtRuntimeMs)
        )
      : 0;
  const selectedAnimation = selectedAnimationId
    ? detectedAnimations.find(
        (animation) => animation.instanceId === selectedAnimationId
      )
    : undefined;
  const selectedAnimationConfigControl =
    selectedAnimation?.configControlId && selectedControlSchema
      ? selectedControlSchema.groups
          .flatMap((group) => group.controls)
          .find((control) => control.id === selectedAnimation.configControlId)
      : undefined;
  const selectedAnimationSpringControl =
    selectedAnimationConfigControl?.kind === "spring"
      ? selectedAnimationConfigControl
      : undefined;
  const selectedAnimationSpringValue =
    schemaId && selectedAnimationSpringControl
      ? asSpringValue(
          state.values[schemaId]?.[selectedAnimationSpringControl.id] ??
            selectedAnimationSpringControl.value ??
            selectedAnimationSpringControl.defaultValue
        )
      : undefined;

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
      replayAnimationBaselineRef.current[schemaId] = schemaAnimations.length;
      setSelectedAnimationId(undefined);
      setPlayheadMs(0);
      if (inspectorMode === "animation") {
        setInspectorMode(probes[0] ? "probe" : "control");
      }
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
        setFramebufferFrameSource(undefined);
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
    setFramebufferFrameSource(undefined);
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
          {schemaIds.length === 0 ? (
            <Empty text="No runtime semantics yet." />
          ) : (
            schemaIds.map((id) => {
              const schema = state.schemas.find((item) => item.id === id);
              const schemaProbes = state.traceSchemas[id] ?? [];
              const controls =
                schema?.groups.flatMap((group) =>
                  group.controls.map((control) => ({ group, control }))
                ) ?? [];

              return (
                <div className="schema" key={id}>
                  <button
                    className={id === schemaId ? "schema-button active" : "schema-button"}
                    onClick={() => {
                      setSchemaId(id);
                      if (schemaProbes[0]) {
                        setProbeId(schemaProbes[0].id);
                        setInspectorMode("probe");
                      } else if (controls[0]) {
                        setSelectedControlId(controls[0].control.id);
                        setInspectorMode("control");
                      }
                    }}
                  >
                    {schema?.title ?? id}
                  </button>

                  {id === schemaId ? (
                    <div className="outline-sections">
                      {controls.length > 0 ? (
                        <div className="outline-section">
                          <div className="outline-section-label">Controls</div>
                          {controls.map(({ group, control }) => (
                            <button
                              key={control.id}
                              className={
                                inspectorMode === "control" &&
                                control.id === selectedControlId
                                  ? "outline-item active"
                                  : "outline-item"
                              }
                              onClick={() => {
                                setSchemaId(id);
                                setSelectedControlId(control.id);
                                setInspectorMode("control");
                              }}
                              title={group.label}
                            >
                              <span className="outline-item-icon">
                                {controlGlyph(control.kind)}
                              </span>
                              <span className="outline-item-copy">
                                <span>{control.label}</span>
                                <small>{control.kind}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {schemaProbes.length > 0 ? (
                        <div className="outline-section">
                          <div className="outline-section-label">Probes</div>
                          {schemaProbes.map((probe) => (
                            <button
                              key={probe.id}
                              className={
                                inspectorMode === "probe" && probe.id === probeId
                                  ? "outline-item active"
                                  : "outline-item"
                              }
                              onClick={() => {
                                setSchemaId(id);
                                setProbeId(probe.id);
                                setInspectorMode("probe");
                              }}
                            >
                              <span className="outline-item-icon probe-icon">⌁</span>
                              <span className="outline-item-copy">
                                <span>{probe.label ?? probe.id}</span>
                                <small>{probe.valueType}</small>
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </aside>

        <section className="runtime-stage">
          <div className="stage-toolbar">
            <div className="stage-toolbar-title">
              <span>Live Runtime</span>
              {runtimeCapture ? (
                <span className="capture-status">
                  <span className="capture-status-dot" />
                  {captureSummary(runtimeCapture, framebufferFrameSource)}
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
          {inspectorMode === "animation" && selectedAnimation ? (
            <AnimationInspector
              animation={selectedAnimation}
              originMs={detectedAnimationOriginMs}
              playheadMs={playheadMs}
              springControl={selectedAnimationSpringControl}
              springValue={selectedAnimationSpringValue}
              stale={selectedSchemaStale}
              onSetSpring={
                schemaId && selectedAnimationSpringControl
                  ? (value) => {
                      replayAnimationBaselineRef.current[schemaId] =
                        schemaAnimations.length;
                      session.setValue(
                        schemaId,
                        selectedAnimationSpringControl.id,
                        value
                      );
                    }
                  : undefined
              }
              onCommitSpring={
                schemaId && selectedAnimationSpringControl
                  ? () =>
                      session.commitValue(
                        schemaId,
                        selectedAnimationSpringControl.id
                      )
                  : undefined
              }
            />
          ) : inspectorMode === "control" && selectedControl && schemaId ? (
            <ControlInspector
              control={selectedControl}
              value={selectedControlValue}
              stale={selectedSchemaStale}
              onSet={(value) => session.setValue(schemaId, selectedControl.id, value)}
              onCommit={() => session.commitValue(schemaId, selectedControl.id)}
              onTrigger={() => session.fireTrigger(schemaId, selectedControl.id)}
              onApplySource={() => session.applySource(schemaId, [selectedControl.id])}
            />
          ) : selectedProbe ? (
            <ProbeInspector probe={selectedProbe} samples={samples} />
          ) : (
            <Empty text="Select a runtime control, probe, or timeline segment." />
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
                : detectedAnimations.length > 0
                  ? `Playhead ${formatTime(playheadMs)}`
                  : "No interaction"}
          </div>
        </div>

        <div className="timeline-body">
          {detectedAnimations.length > 0 ? (
            <AnimationTimeline
              animations={detectedAnimations}
              interactionScoped={replayBaseline !== undefined}
              selectedAnimationId={selectedAnimationId}
              playheadMs={playheadMs}
              onPlayheadChange={setPlayheadMs}
              onSelectAnimation={(animationId) => {
                const animation = detectedAnimations.find(
                  (candidate) => candidate.instanceId === animationId
                );
                setSelectedAnimationId(animationId);
                setInspectorMode("animation");
                if (animation) {
                  setPlayheadMs(
                    Math.max(
                      0,
                      animation.startedAtRuntimeMs - detectedAnimationOriginMs
                    )
                  );
                }
              }}
            />
          ) : (
            <div className="timeline-empty">
              Replay an interaction to reveal its motion in time.
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

const ANIMATION_BURST_IDLE_GAP_MS = 450;

function latestAnimationBurst(
  animations: RuntimeAnimationTrace[]
): RuntimeAnimationTrace[] {
  if (animations.length === 0) return [];

  const ordered = [...animations].sort(
    (left, right) => left.startedAtRuntimeMs - right.startedAtRuntimeMs
  );
  let burstStart = 0;

  for (let index = 1; index < ordered.length; index += 1) {
    const gap =
      ordered[index].startedAtRuntimeMs -
      ordered[index - 1].startedAtRuntimeMs;
    if (gap > ANIMATION_BURST_IDLE_GAP_MS) {
      burstStart = index;
    }
  }

  return ordered.slice(burstStart);
}

function animationDisplayEnd(animation: RuntimeAnimationTrace): number {
  if (animation.endedAtRuntimeMs !== undefined) {
    return animation.endedAtRuntimeMs;
  }
  if (animation.expectedDurationMs !== undefined) {
    return animation.startedAtRuntimeMs + animation.expectedDurationMs;
  }
  return animation.startedAtRuntimeMs + 16;
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

function asSpringValue(value: unknown): SpringValue | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SpringValue>;
  if (
    typeof candidate.damping !== "number" ||
    typeof candidate.stiffness !== "number" ||
    (candidate.mass !== undefined && typeof candidate.mass !== "number")
  ) {
    return undefined;
  }

  return {
    damping: candidate.damping,
    stiffness: candidate.stiffness,
    ...(candidate.mass !== undefined ? { mass: candidate.mass } : {})
  };
}

function controlGlyph(kind: string) {
  switch (kind) {
    case "slider":
      return "↔";
    case "spring":
      return "∿";
    case "bezier":
      return "⌁";
    case "toggle":
      return "◉";
    case "color":
      return "●";
    case "trigger":
      return "▶";
    default:
      return "·";
  }
}

function captureSummary(capture: RuntimeCaptureInfo, frameSource?: string) {
  const size =
    capture.width && capture.height ? `${capture.width}×${capture.height}` : undefined;
  const fps = capture.frameRate ? `${capture.frameRate.toFixed(0)} fps` : undefined;
  const latency =
    capture.latencyMs !== undefined ? `${capture.latencyMs.toFixed(0)} ms` : undefined;
  const encode =
    capture.encodeMs !== undefined ? `enc ${capture.encodeMs.toFixed(1)}` : undefined;
  const decode =
    capture.decodeMs !== undefined ? `dec ${capture.decodeMs.toFixed(1)}` : undefined;
  const source =
    capture.source === "framebuffer"
      ? frameSource === "simscreen-callbacks"
        ? "SimScreen callbacks"
        : frameSource === "seed-polling"
          ? "seed polling"
          : "direct framebuffer"
      : undefined;
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