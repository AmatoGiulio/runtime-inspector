import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createRoot } from "react-dom/client";
import {
  createPanelSession,
  type PanelSession,
  type RuntimeAnimationTrace
} from "@runtime-inspector/panel-core";
import type {
  InspectorControl,
  PanelSchema,
  RuntimeProbeDescriptor,
  SpringValue
} from "@runtime-inspector/protocol";
import {
  AnimationInspector,
  type AnimationInspectorControl
} from "./AnimationInspector";
import { AnimationTimeline } from "./AnimationTimeline";
import {
  buildTimelineModel,
  latestAnimationBurst,
  parameterControl,
  startControl,
  timelineOriginMs
} from "./timeline-model";
import { ControlInspector } from "./ControlInspector";
import { TIMELINE_HEIGHT_STORAGE_KEY, clampTimelineHeight } from "./layout";
import { themeChoiceLabel, useWorkbenchTheme } from "./theme";
import "@runtime-inspector/panel-dialkit/styles.css";
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
  const { choice: themeChoice, resolved: resolvedTheme, cycle: cycleTheme } = useWorkbenchTheme();
  const themeLabel = themeChoiceLabel(themeChoice);
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
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [inspectorMode, setInspectorMode] =
    useState<"probe" | "control" | "animation">("probe");
  const [runtimeCapture, setRuntimeCapture] = useState<RuntimeCaptureInfo>();
  const [runtimeCaptureError, setRuntimeCaptureError] = useState<string>();
  const [simulators, setSimulators] = useState<RuntimeDesktopSimulator[]>([]);
  const [selectedSimulatorUdid, setSelectedSimulatorUdid] = useState<string>();
  // The real bezel of the selected Simulator's device type; undefined keeps the generic frame.
  const [deviceChrome, setDeviceChrome] = useState<RuntimeDesktopDeviceChrome>();
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
  const [outlineVisible, setOutlineVisible] = useState(false);
  // User-chosen timeline height in px; undefined = the CSS default (`--wb-timeline-h`).
  const [timelineHeight, setTimelineHeight] = useState<number | undefined>(
    readStoredTimelineHeight
  );
  const [splitDragging, setSplitDragging] = useState(false);
  const timelineHeightRef = useRef(timelineHeight);
  timelineHeightRef.current = timelineHeight;
  const timelineRef = useRef<HTMLElement>(null);
  const splitDragRef = useRef(false);
  const pendingAnimationSelectionRef = useRef<
    | {
        callsiteId: string;
        /** Instance that was selected when the commit happened; the restored selection must be a newer run. */
        excludeInstanceId: string;
      }
    | undefined
  >(undefined);

  useEffect(() => {
    // Desktop only; a plain browser has no bridge and keeps the generic frame.
    const desktop = window.runtimeDesktop;
    setDeviceChrome(undefined);
    if (!desktop || typeof desktop.getDeviceChrome !== "function" || !selectedSimulatorUdid) return;

    let cancelled = false;
    desktop
      .getDeviceChrome(selectedSimulatorUdid)
      .then((chrome) => {
        if (!cancelled) setDeviceChrome(chrome ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setDeviceChrome(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSimulatorUdid]);

  const deviceFrameStyle = useMemo<CSSProperties | undefined>(
    () => (deviceChrome ? realDeviceFrameStyle(deviceChrome) : undefined),
    [deviceChrome]
  );

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
  const detectedAnimations = useMemo(
    () => latestAnimationBurst(state.runtimeAnimations),
    [state.runtimeAnimations]
  );
  const detectedAnimationOriginMs = timelineOriginMs(detectedAnimations);
  const timelineDurationMs = useMemo(
    () =>
      detectedAnimations.length > 0
        ? buildTimelineModel(detectedAnimations).durationMs
        : undefined,
    [detectedAnimations]
  );
  const replayTarget = useMemo(() => {
    for (const schema of state.schemas) {
      for (const group of schema.groups) {
        for (const control of group.controls) {
          if (
            control.kind === "trigger" &&
            (control.id.toLowerCase().includes("replay") ||
              control.binding?.toLowerCase().includes("replay"))
          ) {
            return { schemaId: schema.id, controlId: control.id };
          }
        }
      }
    }
    return undefined;
  }, [state.schemas]);
  const selectedAnimation = selectedAnimationId
    ? detectedAnimations.find(
        (animation) => animation.instanceId === selectedAnimationId
      )
    : undefined;
  // Own schema first; the Outline-selected schema only stands in when the animation names none.
  const animationFallbackSchemaId = selectedAnimation?.schemaId ? undefined : schemaId;
  const selectedAnimationCallsiteId = selectedAnimation?.callsiteId;
  /**
   * Real schema controls (relabeled where needed) behind the selected animation's parameters.
   * `InspectorControlRow` remounts its editor when the `control` identity changes, so these
   * copies are rebuilt only when the schemas or the selected call site change, never per
   * render and never per run of the same call site.
   */
  const animationControlEntries = useMemo(() => {
    const animation = selectedAnimation;
    if (!animation) return [];

    const refs: Array<{
      key: string;
      label?: string;
      schemaId: string;
      controlId: string;
    }> = [];
    if (animation.startControl) {
      refs.push({ key: "delay", label: "Delay", ...animation.startControl });
    }
    for (const [key, label] of ANIMATION_PARAMETER_LABELS) {
      const ref = animation.parameterControls?.[key];
      if (ref) refs.push({ key, label, ...ref });
    }
    const configSchemaId = animation.schemaId ?? animationFallbackSchemaId;
    if (animation.configControlId && configSchemaId) {
      refs.push({
        key: `config:${animation.configControlId}`,
        schemaId: configSchemaId,
        controlId: animation.configControlId
      });
    }

    const entries: Array<{ key: string; schemaId: string; control: InspectorControl }> = [];
    for (const ref of refs) {
      const control = findSchemaControl(state.schemas, ref.schemaId, ref.controlId);
      if (!control) continue;
      entries.push({
        key: ref.key,
        schemaId: ref.schemaId,
        control:
          ref.label === undefined
            ? control
            : ({ ...control, label: ref.label } as InspectorControl)
      });
    }
    return entries;
    // The refs are per call site; later runs of the same call site must keep these identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.schemas, selectedAnimationCallsiteId, animationFallbackSchemaId]);
  const animationInspectorControls: AnimationInspectorControl[] =
    animationControlEntries.map((entry) => ({
      ...entry,
      value: state.values[entry.schemaId]?.[entry.control.id],
      disabled: Boolean(state.staleSchemaIds[entry.schemaId])
    }));
  const springPreviewDamping = animationSpringParameter(
    selectedAnimation,
    animationInspectorControls,
    "damping"
  );
  const springPreviewStiffness = animationSpringParameter(
    selectedAnimation,
    animationInspectorControls,
    "stiffness"
  );
  const springPreviewMass = animationSpringParameter(
    selectedAnimation,
    animationInspectorControls,
    "mass"
  );
  // A spring driven by a `spring` control is drawn by that control's own DialKit folder.
  const wantsSpringPreview =
    selectedAnimation?.animationKind === "spring" && !selectedAnimation.configControlId;
  const springPreview = useMemo<SpringValue | undefined>(() => {
    if (
      !wantsSpringPreview ||
      springPreviewDamping === undefined ||
      springPreviewStiffness === undefined
    ) {
      return undefined;
    }
    return {
      damping: springPreviewDamping,
      stiffness: springPreviewStiffness,
      ...(springPreviewMass !== undefined ? { mass: springPreviewMass } : {})
    };
  }, [wantsSpringPreview, springPreviewDamping, springPreviewStiffness, springPreviewMass]);
  const animationActionsRef = useRef({
    animation: selectedAnimation,
    queueRestore: queueAnimationSelectionRestore,
    replay
  });
  animationActionsRef.current = {
    animation: selectedAnimation,
    queueRestore: queueAnimationSelectionRestore,
    replay
  };
  /** Forwards to the real session; a commit also restores the selection and replays once. */
  const animationSession = useMemo<
    Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">
  >(
    () => ({
      setValue: (schemaId, controlId, value) =>
        session.setValue(schemaId, controlId, value),
      fireTrigger: (schemaId, controlId) =>
        session.fireTrigger(schemaId, controlId),
      commitValue: (schemaId, controlId) => {
        const { animation, queueRestore, replay } = animationActionsRef.current;
        if (animation) queueRestore(animation);
        session.commitValue(schemaId, controlId);
        replay(true);
      }
    }),
    []
  );

  useEffect(() => {
    const pending = pendingAnimationSelectionRef.current;
    if (!pending || detectedAnimations.length === 0) return;

    const next = [...detectedAnimations]
      .reverse()
      .find(
        (animation) =>
          animation.callsiteId === pending.callsiteId &&
          animation.instanceId !== pending.excludeInstanceId
      );
    if (!next) return;

    pendingAnimationSelectionRef.current = undefined;
    setSelectedAnimationId(next.instanceId);
    setInspectorMode("animation");
  }, [detectedAnimations, detectedAnimationOriginMs]);

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

  useEffect(() => {
    const onResize = () =>
      setTimelineHeight((current) =>
        current === undefined ? current : clampTimelineHeight(current, window.innerHeight)
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function persistTimelineHeight(height: number | undefined) {
    try {
      if (height === undefined) {
        window.localStorage.removeItem(TIMELINE_HEIGHT_STORAGE_KEY);
      } else {
        window.localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(height));
      }
    } catch {
      // Storage can be unavailable; the height then only lasts for this session.
    }
  }

  function handleSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    splitDragRef.current = true;
    setSplitDragging(true);
  }

  function handleSplitPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitDragRef.current) return;
    setTimelineHeight(
      clampTimelineHeight(window.innerHeight - event.clientY, window.innerHeight)
    );
  }

  function endSplitDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitDragRef.current) return;
    splitDragRef.current = false;
    setSplitDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    persistTimelineHeight(timelineHeightRef.current);
  }

  function handleSplitKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const current =
      timelineHeightRef.current ?? timelineRef.current?.getBoundingClientRect().height;
    if (current === undefined) return;
    // The handle sits above the timeline: moving it up makes the timeline taller.
    const next = clampTimelineHeight(
      current + (event.key === "ArrowUp" ? 16 : -16),
      window.innerHeight
    );
    setTimelineHeight(next);
    persistTimelineHeight(next);
  }

  function resetTimelineHeight() {
    setTimelineHeight(undefined);
    persistTimelineHeight(undefined);
  }

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

  function replay(preserveAnimationInspector = false) {
    if (!replayTarget) return;
    setSelectedAnimationId(undefined);
    setPlayheadMs(0);
    if (!preserveAnimationInspector && inspectorMode === "animation") {
      setInspectorMode(probes[0] ? "probe" : "control");
    }
    session.fireTrigger(replayTarget.schemaId, replayTarget.controlId);
    setTimelinePlaying(true);
  }

  /** After the next replay, re-select the same call site (a newer run than `animation`). */
  function queueAnimationSelectionRestore(animation: RuntimeAnimationTrace) {
    pendingAnimationSelectionRef.current = {
      callsiteId: animation.callsiteId,
      excludeInstanceId: animation.instanceId
    };
  }

  /** Every animation edit: set + commit the controls, then replay once. */
  function commitAnimationControls(
    animation: RuntimeAnimationTrace,
    changes: Array<{ schemaId: string; controlId: string; value: number }>
  ) {
    queueAnimationSelectionRestore(animation);
    for (const change of changes) {
      session.setValue(change.schemaId, change.controlId, change.value);
      session.commitValue(change.schemaId, change.controlId);
    }
    replay(true);
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
          source: "framebuffer",
          ...(prepared.bootstrapFrame
            ? { width: prepared.bootstrapFrame.width, height: prepared.bootstrapFrame.height }
            : {})
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

  const isFramebuffer = runtimeCapture?.source === "framebuffer";

  return (
    <main
      className={window.runtimeDesktop ? "workbench desktop" : "workbench"}
      style={
        timelineHeight !== undefined
          ? ({ "--wb-timeline-h": `${timelineHeight}px` } as CSSProperties)
          : undefined
      }
    >
      <header className="topbar">
        <div className="brand">Runtime Inspector</div>
        <button
          type="button"
          className="wb-button toggle"
          aria-pressed={outlineVisible}
          onClick={() => setOutlineVisible((visible) => !visible)}
        >
          Controls
        </button>
        {state.notice && <div className="notice">{state.notice}</div>}
        <div className="topbar-spacer" />

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

          {runtimeCapture ? (
            <span
              className="wb-pill"
              data-dot={runtimeCapture.source === "framebuffer" ? "success" : "muted"}
              title={captureSummary(runtimeCapture, framebufferFrameSource)}
            >
              {runtimeCapture.source === "framebuffer" ? "Live" : "View only"}
            </span>
          ) : null}

          {runtimeCapture?.source === "framebuffer" && window.runtimeDesktop ? (
            inputReady ? (
              <span
                className="wb-pill emphasis"
                data-dot="success"
                title="Native Simulator HID input enabled"
              >
                Input on
              </span>
            ) : (
              <button
                className="wb-button secondary"
                type="button"
                onClick={retrySimulatorInput}
              >
                Retry Input
              </button>
            )
          ) : null}

          <button
            className={runtimeCapture ? "wb-button secondary" : "wb-button primary"}
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

        <button
          type="button"
          className="wb-button toggle theme-toggle"
          onClick={cycleTheme}
          title={`Theme: ${themeLabel}`}
          aria-label={`Theme: ${themeLabel}`}
        >
          {themeLabel}
        </button>

        <div
          className="wb-pill emphasis connection"
          data-status={state.status}
          data-dot={state.status === "connected" ? "success" : "muted"}
        >
          {state.status}
        </div>
      </header>

      <section
        className={outlineVisible ? "workspace" : "workspace no-outline"}
      >
        {outlineVisible ? (
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
                      className={
                        id === schemaId
                          ? "wb-button toggle schema-button active"
                          : "wb-button toggle schema-button"
                      }
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
                                    ? "wb-button toggle outline-item active"
                                    : "wb-button toggle outline-item"
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
                                    ? "wb-button toggle outline-item active"
                                    : "wb-button toggle outline-item"
                                }
                                onClick={() => {
                                  setSchemaId(id);
                                  setProbeId(probe.id);
                                  setInspectorMode("probe");
                                }}
                              >
                                <span className="outline-item-icon">⌁</span>
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
        ) : null}

        <section className="runtime-stage">
          <div className="runtime-surface">
            {runtimeCapture?.source === "window" ? (
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
            ) : (
              <div
                className={`device-frame${deviceChrome ? " real" : ""}`}
                style={deviceFrameStyle}
              >
                <div
                  className={`device-frame-screen${isFramebuffer && inputReady ? " interactive" : ""}${
                    deviceChrome && !deviceChrome.maskDataUrl ? " unmasked" : ""
                  }`}
                  style={realDeviceScreenStyle(
                    deviceChrome,
                    isFramebuffer && runtimeCapture?.width && runtimeCapture?.height
                      ? runtimeCapture.width / runtimeCapture.height
                      : undefined
                  )}
                  onPointerDown={handleRuntimePointerDown}
                  onPointerMove={handleRuntimePointerMove}
                  onPointerUp={handleRuntimePointerUp}
                  onPointerCancel={handleRuntimePointerUp}
                >
                  {isFramebuffer ? (
                    <canvas
                      ref={framebufferCanvasRef}
                      className={`runtime-framebuffer${framebufferHasFrame ? " ready" : ""}`}
                      aria-label="Live iOS Simulator framebuffer"
                    />
                  ) : null}
                  {!runtimeCapture ? (
                    <>
                      <div className="device-eyebrow">Real runtime</div>
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
                        className="wb-button primary device-attach"
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
                    </>
                  ) : null}
                  {isFramebuffer && !framebufferHasFrame ? (
                    <div className="framebuffer-loading">Connecting to the Simulator…</div>
                  ) : null}
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
          {inspectorMode === "animation" ? (
            selectedAnimation ? (
            <AnimationInspector
              animation={selectedAnimation}
              originMs={detectedAnimationOriginMs}
              controls={animationInspectorControls}
              springPreview={springPreview}
              session={animationSession}
              theme={resolvedTheme}
            />
            ) : (
              <Empty text="Waiting for the next matching animation…" />
            )
          ) : inspectorMode === "control" && selectedControl && schemaId ? (
            <ControlInspector
              schemaId={schemaId}
              control={selectedControl}
              value={selectedControlValue}
              stale={selectedSchemaStale}
              session={session}
              theme={resolvedTheme}
              onApplySource={() => session.applySource(schemaId, [selectedControl.id])}
            />
          ) : selectedProbe ? (
            <ProbeInspector probe={selectedProbe} samples={samples} />
          ) : (
            <Empty text="Select a runtime control, probe, or timeline segment." />
          )}
        </aside>
      </section>

      <div
        className="split-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        tabIndex={0}
        data-dragging={splitDragging ? "" : undefined}
        onPointerDown={handleSplitPointerDown}
        onPointerMove={handleSplitPointerMove}
        onPointerUp={endSplitDrag}
        onPointerCancel={endSplitDrag}
        onKeyDown={handleSplitKeyDown}
        onDoubleClick={resetTimelineHeight}
      />

      <section
        ref={timelineRef}
        className="timeline dialkit-root"
        data-theme={resolvedTheme}
      >
        <div className="timeline-toolbar">
          <button
            className="wb-button primary timeline-play"
            type="button"
            title="Play"
            aria-label="Play"
            onClick={() => replay()}
            disabled={!replayTarget}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M9.24394 2.36758C7.41419 1.18362 5 2.49701 5 4.67639V19.3238C5 21.5032 7.41419 22.8166 9.24394 21.6326L20.5624 14.3089C22.2371 13.2253 22.2372 10.775 20.5624 9.69129L9.24394 2.36758Z"
                fill="currentColor"
              />
            </svg>
            Play
          </button>
          <div className="timeline-time dialkit-timeline-time">
            {timelineDurationMs !== undefined ? (
              <>
                <span>{formatTime(playheadMs)}</span>
                <span className="timeline-time-total">
                  {" / "}
                  {formatTime(timelineDurationMs)}
                </span>
              </>
            ) : (
              "—"
            )}
          </div>
          <div className="timeline-spacer" />
          <div className="timeline-meta">
            {viewportBenchmarkResult
              ? benchmarkSummary(viewportBenchmarkResult)
              : recording
                ? `${recording.samples.length} samples · ${recording.sampleRateHz} Hz${recording.incomplete ? " · gap" : ""}`
                : detectedAnimations.length > 0
                  ? `${detectedAnimations.length} animations`
                  : "No interaction"}
          </div>
          <details className="timeline-dev">
            <summary className="wb-button secondary">Developer</summary>
            <div className="timeline-dev-menu">
              {runtimeCapture ? (
                <div className="timeline-dev-info">
                  <span>Viewport</span>{" "}
                  <span>{captureSummary(runtimeCapture, framebufferFrameSource)}</span>
                </div>
              ) : null}
              <button
                className={
                  isRecording
                    ? "wb-button secondary record active"
                    : "wb-button secondary record"
                }
                onClick={toggleRecording}
              >
                <span className="record-dot" />
                {isRecording ? "Stop" : "Record"}
              </button>
              <button
                className="wb-button secondary"
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
                className="wb-button secondary"
                onClick={() => session.clearRecording()}
                disabled={isRecording || !recording}
              >
                Clear
              </button>
            </div>
          </details>
        </div>

        <div className="timeline-body">
          {detectedAnimations.length > 0 ? (
            <AnimationTimeline
              animations={detectedAnimations}
              selectedAnimationId={selectedAnimationId}
              playheadMs={playheadMs}
              playing={timelinePlaying}
              getDurationRange={(animation) => {
                if (animation.animationKind !== "timing") return undefined;
                const c = parameterControl(
                  animation,
                  "duration",
                  state.schemas,
                  state.values
                );
                return c && !state.staleSchemaIds[c.schemaId]
                  ? { min: c.min, max: c.max, step: c.step }
                  : undefined;
              }}
              getStartRange={(animation) => {
                const c = startControl(animation, state.schemas, state.values);
                return c && !state.staleSchemaIds[c.schemaId]
                  ? { min: c.min, max: c.max, step: c.step, value: c.value }
                  : undefined;
              }}
              onResizeDuration={(animationId, durationMs) => {
                const animation = detectedAnimations.find(
                  (candidate) => candidate.instanceId === animationId
                );
                if (!animation) return;
                const c = parameterControl(
                  animation,
                  "duration",
                  state.schemas,
                  state.values
                );
                if (!c) return;
                commitAnimationControls(animation, [
                  { schemaId: c.schemaId, controlId: c.controlId, value: durationMs }
                ]);
              }}
              onMoveStart={(animationId, delayMs) => {
                const animation = detectedAnimations.find(
                  (candidate) => candidate.instanceId === animationId
                );
                if (!animation) return;
                const c = startControl(animation, state.schemas, state.values);
                if (!c) return;
                commitAnimationControls(animation, [
                  { schemaId: c.schemaId, controlId: c.controlId, value: delayMs }
                ]);
              }}
              onResizeStart={(animationId, delayMs, durationMs) => {
                const animation = detectedAnimations.find(
                  (candidate) => candidate.instanceId === animationId
                );
                if (!animation) return;
                const start = startControl(
                  animation,
                  state.schemas,
                  state.values
                );
                const duration = parameterControl(
                  animation,
                  "duration",
                  state.schemas,
                  state.values
                );
                if (!start || !duration) return;
                commitAnimationControls(animation, [
                  {
                    schemaId: start.schemaId,
                    controlId: start.controlId,
                    value: delayMs
                  },
                  {
                    schemaId: duration.schemaId,
                    controlId: duration.controlId,
                    value: durationMs
                  }
                ]);
              }}
              onPlayheadChange={(ms) => {
                setPlayheadMs(ms);
                setTimelinePlaying(false);
              }}
              onSelectAnimation={(animationId) => {
                setSelectedAnimationId(animationId);
                setInspectorMode("animation");
              }}
            />
          ) : (
            <div className="timeline-empty">
              Press Play to capture the interaction.
            </div>
          )}
        </div>
      </section>
    </main>
  );
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

const ANIMATION_PARAMETER_LABELS = [
  ["duration", "Duration"],
  ["damping", "Damping"],
  ["stiffness", "Stiffness"],
  ["mass", "Mass"]
] as const;

function findSchemaControl(
  schemas: readonly PanelSchema[],
  schemaId: string,
  controlId: string
): InspectorControl | undefined {
  const schema = schemas.find((candidate) => candidate.id === schemaId);
  if (!schema) return undefined;
  for (const group of schema.groups) {
    const control = group.controls.find((candidate) => candidate.id === controlId);
    if (control) return control;
  }
  return undefined;
}

/** Current numeric value of a spring parameter: its control's live value, else the resolved config. */
function animationSpringParameter(
  animation: RuntimeAnimationTrace | undefined,
  controls: readonly AnimationInspectorControl[],
  key: "damping" | "stiffness" | "mass"
): number | undefined {
  if (!animation) return undefined;
  const live = controls.find((entry) => entry.key === key)?.value;
  if (typeof live === "number" && Number.isFinite(live)) return live;
  const resolved = animation.resolvedConfig[key];
  return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : undefined;
}

/** The stored timeline height, re-clamped to the current viewport; undefined when absent or invalid. */
/**
 * Frame style for the real bezel. Geometry is exposed as unitless point values; the stylesheet
 * derives `--device-k` (CSS px per point) from the available stage height. The composite is a
 * 9-slice whose corner slice is `cornerSlicePt` points, i.e. `cornerSlicePt * compositeScale` px.
 */
function realDeviceFrameStyle(chrome: RuntimeDesktopDeviceChrome): CSSProperties {
  const { geometry } = chrome;
  const { bezel } = geometry;
  const innerRadiusPt = Math.max(
    0,
    (geometry.outerCornerRadiusPt ?? 0) - Math.min(bezel.top, bezel.right, bezel.bottom, bezel.left)
  );

  return {
    "--device-screen-w": String(geometry.screen.widthPt),
    "--device-screen-h": String(geometry.screen.heightPt),
    "--device-bezel-top": String(bezel.top),
    "--device-bezel-right": String(bezel.right),
    "--device-bezel-bottom": String(bezel.bottom),
    "--device-bezel-left": String(bezel.left),
    "--device-corner": String(geometry.cornerSlicePt),
    "--device-outer-radius": String(geometry.outerCornerRadiusPt ?? 0),
    "--device-inner-radius": String(innerRadiusPt),
    borderImageSource: `url("${chrome.compositeDataUrl}")`,
    borderImageSlice: `${geometry.cornerSlicePt * chrome.compositeScale} fill`
  } as CSSProperties;
}

/**
 * Screen style: the device aspect ratio (the live framebuffer's own ratio wins once frames
 * arrive) and the true screen shape as a mask. A mask never changes the element's box, so the
 * pointer handlers' getBoundingClientRect() stays exactly the framebuffer box.
 */
function realDeviceScreenStyle(
  chrome: RuntimeDesktopDeviceChrome | undefined,
  framebufferAspect: number | undefined
): CSSProperties | undefined {
  const style: CSSProperties = {};

  if (chrome) {
    style.aspectRatio = String(chrome.geometry.screen.widthPt / chrome.geometry.screen.heightPt);
    if (chrome.maskDataUrl) {
      const mask = `url("${chrome.maskDataUrl}")`;
      style.maskImage = mask;
      style.WebkitMaskImage = mask;
    }
  }
  if (framebufferAspect !== undefined) {
    style.aspectRatio = String(framebufferAspect);
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function readStoredTimelineHeight(): number | undefined {
  try {
    const raw = window.localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? clampTimelineHeight(value, window.innerHeight) : undefined;
  } catch {
    return undefined;
  }
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