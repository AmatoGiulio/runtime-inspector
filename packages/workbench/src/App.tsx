import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
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
  width?: number;
  height?: number;
  frameRate?: number;
  displaySurface?: string;
  crop?: RuntimeDesktopCrop;
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
  const runtimeStreamRef = useRef<MediaStream | undefined>(undefined);
  const runtimeVideoRef = useRef<HTMLVideoElement>(null);

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

  async function attachRuntimeCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setRuntimeCaptureError("This runtime does not support window capture.");
      return;
    }

    const desktop = window.runtimeDesktop;
    setRuntimeCaptureError(undefined);
    setDesktopBusy(Boolean(desktop));

    try {
      runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());

      let prepared: RuntimeDesktopCapturePreparation | undefined;
      if (desktop) {
        prepared = await desktop.prepareSimulatorCapture(selectedSimulatorUdid);
        setSelectedSimulatorUdid(prepared.device.udid);
        setSimulators(await desktop.listSimulators());
        const ready = Boolean(prepared.input.ready && prepared.crop);
        setInputReady(ready);
        if (!prepared.input.ready) {
          setRuntimeCaptureError(prepared.input.error ?? "Simulator HID input is unavailable.");
        }
      } else {
        setInputReady(false);
      }

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
        label: prepared?.device
          ? `${prepared.device.name} · ${prepared.device.runtime}`
          : track.label || "Captured window",
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        displaySurface: settings.displaySurface,
        crop: prepared?.crop
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
        error instanceof Error ? error.message : "Could not attach the runtime window."
      );
    } finally {
      setDesktopBusy(false);
    }
  }

  function detachRuntimeCapture() {
    runtimeStreamRef.current?.getTracks().forEach((track) => track.stop());
    runtimeStreamRef.current = undefined;
    if (runtimeVideoRef.current) {
      runtimeVideoRef.current.srcObject = null;
    }
    setRuntimeCapture(undefined);
    setRuntimeCaptureError(undefined);
    setInputReady(false);
  }

  async function retrySimulatorInput() {
    const desktop = window.runtimeDesktop;
    if (!desktop || !runtimeCapture?.crop) return;

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
                inputReady ? (
                  <span className="input-status" title="Native Simulator HID input enabled">
                    Input on
                  </span>
                ) : runtimeCapture.crop ? (
                  <button
                    className="stage-action"
                    type="button"
                    onClick={retrySimulatorInput}
                  >
                    Retry Input
                  </button>
                ) : (
                  <span
                    className="input-status pending"
                    title="Window capture is view-only until the direct CoreSimulator framebuffer adapter lands."
                  >
                    Framebuffer pending
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
              <div
                className={[
                  runtimeCapture.crop ? "runtime-video-shell device-crop" : "runtime-video-shell",
                  inputReady ? "interactive" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={runtimeShellStyle(runtimeCapture)}
                onPointerDown={handleRuntimePointerDown}
                onPointerMove={handleRuntimePointerMove}
                onPointerUp={handleRuntimePointerUp}
                onPointerCancel={handleRuntimePointerUp}
              >
                <video
                  ref={runtimeVideoRef}
                  className="runtime-video"
                  style={runtimeVideoStyle(runtimeCapture)}
                  autoPlay
                  muted
                  playsInline
                />
                {!runtimeCapture.crop ? (
                  <div className="runtime-video-caption">
                    <span>{runtimeCapture.label}</span>
                    <span>
                      {window.runtimeDesktop
                        ? inputReady
                          ? "Interactive · native Simulator HID"
                          : "Window fallback · direct framebuffer pending"
                        : "Interact in the Simulator window · browser capture is view-only"}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="device-placeholder">
                <div className="device-screen">
                  <div className="device-eyebrow">REAL RUNTIME</div>
                  <div className="device-title">
                    {window.runtimeDesktop ? "Launch the iOS Simulator" : "Attach the iOS Simulator"}
                  </div>
                  <div className="device-copy">
                    {window.runtimeDesktop
                      ? "Runtime Inspector can discover installed simulators, boot the selected target, find its window and attach it without a sharing picker."
                      : "Choose the Simulator window in the macOS sharing picker. Runtime Inspector will render that live window here while trace recording stays on RIP."}
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
            onClick={() => session.clearRecording()}
            disabled={isRecording || !recording}
          >
            Clear
          </button>
          <div className="timeline-meta">
            {recording
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

function runtimeShellStyle(capture: RuntimeCaptureInfo): CSSProperties | undefined {
  const crop = capture.crop;
  if (!crop || !capture.width || !capture.height) return undefined;

  const cropWidthPx = crop.width * capture.width;
  const cropHeightPx = crop.height * capture.height;
  if (cropWidthPx <= 0 || cropHeightPx <= 0) return undefined;

  return {
    aspectRatio: String(cropWidthPx / cropHeightPx)
  };
}

function runtimeVideoStyle(capture: RuntimeCaptureInfo): CSSProperties | undefined {
  const crop = capture.crop;
  if (!crop) return undefined;

  return {
    position: "absolute",
    width: `${100 / crop.width}%`,
    maxWidth: "none",
    maxHeight: "none",
    left: `${(-crop.x / crop.width) * 100}%`,
    top: `${(-crop.y / crop.height) * 100}%`
  };
}

function captureSummary(capture: RuntimeCaptureInfo) {
  const size =
    capture.width && capture.height ? `${capture.width}×${capture.height}` : undefined;
  const fps = capture.frameRate ? `${capture.frameRate.toFixed(0)} fps` : undefined;
  const crop = capture.crop ? "device crop" : undefined;
  return [size, fps, crop].filter(Boolean).join(" · ") || "attached";
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