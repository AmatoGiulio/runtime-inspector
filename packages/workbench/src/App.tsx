import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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

function App() {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const traceEntries = Object.entries(state.traceSchemas);
  const [schemaId, setSchemaId] = useState<string>();
  const [probeId, setProbeId] = useState<string>();

  useEffect(() => {
    if (!schemaId && traceEntries[0]) {
      setSchemaId(traceEntries[0][0]);
    }
  }, [schemaId, traceEntries]);

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
            <span>Live Runtime</span>
            <span className="stage-note">device viewport · M3/M4</span>
          </div>
          <div className="device-placeholder">
            <div className="device-screen">
              <div className="device-eyebrow">REAL RUNTIME</div>
              <div className="device-title">iOS Simulator / Android Emulator</div>
              <div className="device-copy">
                M0 validates the semantic trace path first. The captured simulator viewport lands
                after recording overhead is proven safe.
              </div>
            </div>
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