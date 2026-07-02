import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  RIP_VERSION,
  createPatch,
  isValueControl,
  parseRIPMessage,
  type BezierControl,
  type ColorControl,
  type CubicBezier,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
  type SpringControl,
  type SpringValue,
  type ToggleControl,
  type TriggerControl
} from "@runtime-inspector/protocol";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ConnectionState = "connecting" | "connected" | "disconnected";
type PendingPatch = {
  controlId: string;
  value: unknown;
  timer: number | undefined;
  lastSentAt: number;
};
type CompareSlot = "A" | "B";
type LastPatch = {
  controlId: string;
  label: string;
  at: string;
};

const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const sliderThrottleMs = 50;

function App() {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [schema, setSchema] = useState<PanelSchema>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [compare, setCompare] = useState<Partial<Record<CompareSlot, Record<string, unknown>>>>({});
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [lastPatch, setLastPatch] = useState<LastPatch>();
  const socketRef = useRef<WebSocket | null>(null);
  const pendingPatchesRef = useRef(new Map<string, PendingPatch>());

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let closedByReact = false;

    const connect = () => {
      setStatus("connecting");
      const socket = new WebSocket(brokerUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        setStatus("connected");
        setNotice(undefined);
        socket.send(
          JSON.stringify({
            type: "handshake.hello",
            protocolVersion: RIP_VERSION,
            role: "panel",
            clientId: "panel-web",
            clientName: "Runtime Inspector Web Panel"
          })
        );
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        setStatus("disconnected");
        setNotice("Broker disconnected. Reconnecting...");
        if (!closedByReact) {
          reconnectTimer = window.setTimeout(connect, 1000);
        }
      };

      socket.onerror = () => {
        setNotice("WebSocket connection error.");
        socket.close();
      };

      socket.onmessage = (event) => {
        const message = parsePanelMessage(event.data);
        if (!message) {
          setNotice("Ignored invalid protocol message from broker.");
          return;
        }

        if (message.type === "schema.publish") {
          setSchema(message.schema);
          setValues(collectInitialValues(message.schema));
          setNotice(undefined);
        }
        if (message.type === "control.patch") {
          const controlId = message.controlId;
          setValues((current) => ({ ...current, [controlId]: message.value }));
        }
        if (message.type === "control.batchPatch") {
          setValues((current) => ({
            ...current,
            ...Object.fromEntries(
              message.patches.map((patch) => [patch.controlId, patch.value])
            )
          }));
        }
      };
    };

    connect();

    return () => {
      closedByReact = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      clearPendingPatches(pendingPatchesRef.current);
      socketRef.current?.close();
    };
  }, []);

  const preset = useMemo(() => {
    if (!schema) return "";
    return JSON.stringify(
      {
        schemaId: schema.id,
        schemaVersion: schema.version,
        name: `${schema.title} Preset`,
        exportedAt: new Date().toISOString(),
        values
      },
      null,
      2
    );
  }, [schema, values]);

  const codeExport = useMemo(() => {
    if (!schema) return "";
    return createTypeScriptPreset(schema, values);
  }, [schema, values]);

  const controlStats = useMemo(() => {
    if (!schema) return { advanced: 0, live: 0 };
    return schema.groups.reduce(
      (stats, controlGroup) => {
        const isAdvanced = controlGroup.id.includes("replay");
        return {
          advanced: stats.advanced + (isAdvanced ? controlGroup.controls.length : 0),
          live: stats.live + (isAdvanced ? 0 : controlGroup.controls.length)
        };
      },
      { advanced: 0, live: 0 }
    );
  }, [schema]);

  const controlsById = useMemo(() => {
    if (!schema) return new Map<string, InspectorControl>();
    return new Map(
      schema.groups.flatMap((controlGroup) =>
        controlGroup.controls.map((control) => [control.id, control] as const)
      )
    );
  }, [schema]);

  function updateValue(control: InspectorControl, value: unknown) {
    if (!schema) return;
    if (!isPatchValueValid(control, value)) {
      setNotice(`Invalid value for ${control.label}.`);
      return;
    }

    if (isValueControl(control)) {
      setValues((current) => ({ ...current, [control.id]: value }));
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(createPatch(schema.id, control.id, value)));
    }
    markPatch(control);
  }

  function updateSliderValue(control: SliderControl, value: number) {
    if (!schema) return;
    if (!isPatchValueValid(control, value)) {
      setNotice(`Invalid value for ${control.label}.`);
      return;
    }

    setValues((current) => ({ ...current, [control.id]: value }));
    sendPatchThrottled(schema.id, control.id, value, socketRef, pendingPatchesRef);
    markPatch(control);
  }

  function flushControl(controlId: string) {
    if (!schema) return;
    flushPendingPatch(schema.id, controlId, socketRef, pendingPatchesRef);
  }

  async function copyCode() {
    if (!codeExport) return;
    await navigator.clipboard.writeText(codeExport);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function saveCompareSlot(slot: CompareSlot) {
    setCompare((current) => ({
      ...current,
      [slot]: structuredClone(values)
    }));
  }

  function applyCompareSlot(slot: CompareSlot) {
    const snapshot = compare[slot];
    if (!schema || !snapshot) return;

    const validSnapshot = filterValidSnapshot(snapshot, controlsById);
    setValues(validSnapshot);
    sendBatchPatch(schema.id, validSnapshot, socketRef);
    const replayTrigger = findReplayTrigger(schema);
    if (replayTrigger) {
      window.setTimeout(() => {
        sendPatch(schema.id, replayTrigger.id, Date.now(), socketRef);
      }, 80);
    }
    setLastPatch({
      controlId: `compare-${slot}`,
      label: `Applied ${slot}`,
      at: formatTime(new Date())
    });
  }

  function markPatch(control: InspectorControl) {
    setLastPatch({
      controlId: control.id,
      label: control.label,
      at: formatTime(new Date())
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Runtime Inspector</h1>
          <p>{notice ?? (schema ? schema.title : "Waiting for runtime schema")}</p>
        </div>
        <div className="topbarMeta">
          {schema ? (
            <span className="metaText">
              {controlStats.live} live / {controlStats.advanced} replay
            </span>
          ) : null}
          {lastPatch ? (
            <span className="metaText">Last patch: {lastPatch.label} {lastPatch.at}</span>
          ) : null}
          <span className={`status ${status}`}>{status}</span>
        </div>
      </header>

      {!schema ? (
        <section className="empty">
          <h2>No schema published</h2>
          <p>Start a React Native runtime and call definePanel().connect().</p>
        </section>
      ) : (
        <div className="layout">
          <section className="groups">
            {schema.groups.map((controlGroup) => (
              <section className="group" key={controlGroup.id}>
                <div className="groupHeader">
                  <div className="groupTitleRow">
                    <h2>{controlGroup.label}</h2>
                    <span className={`groupBadge ${controlGroup.id.includes("replay") ? "replay" : "live"}`}>
                      {controlGroup.id.includes("replay") ? "Replay" : "Live"}
                    </span>
                  </div>
                  {controlGroup.description ? <p>{controlGroup.description}</p> : null}
                </div>
                <div className="controls">
                  {controlGroup.controls.map((control) => (
                    <ControlRow
                      control={control}
                      key={control.id}
                      value={getControlValue(control, values)}
                      onChange={(value) => updateValue(control, value)}
                      onSliderChange={updateSliderValue}
                      onCommit={flushControl}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
          <aside className="exports">
            <section className="exportPanel">
              <h2>A/B Compare</h2>
              <div className="compareGrid">
                <CompareSlotControls
                  hasSnapshot={Boolean(compare.A)}
                  label="A"
                  onApply={() => applyCompareSlot("A")}
                  onSave={() => saveCompareSlot("A")}
                />
                <CompareSlotControls
                  hasSnapshot={Boolean(compare.B)}
                  label="B"
                  onApply={() => applyCompareSlot("B")}
                  onSave={() => saveCompareSlot("B")}
                />
              </div>
            </section>
            <section className="exportPanel">
              <div className="exportHeader">
                <h2>TypeScript</h2>
                <button type="button" onClick={copyCode}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre>{codeExport}</pre>
            </section>
            <section className="exportPanel">
              <h2>Preset JSON</h2>
              <pre>{preset}</pre>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}

function filterValidSnapshot(
  snapshot: Record<string, unknown>,
  controlsById: Map<string, InspectorControl>
) {
  return Object.fromEntries(
    Object.entries(snapshot).filter(([controlId, value]) => {
      const control = controlsById.get(controlId);
      return control ? isPatchValueValid(control, value) : false;
    })
  );
}

function CompareSlotControls({
  hasSnapshot,
  label,
  onApply,
  onSave
}: {
  hasSnapshot: boolean;
  label: CompareSlot;
  onApply: () => void;
  onSave: () => void;
}) {
  return (
    <div className="compareSlot">
      <span>{label}</span>
      <button type="button" onClick={onSave}>
        Save
      </button>
      <button type="button" disabled={!hasSnapshot} onClick={onApply}>
        Apply
      </button>
    </div>
  );
}

function parsePanelMessage(data: unknown) {
  try {
    const raw = typeof data === "string" ? data : String(data);
    return parseRIPMessage(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function ControlRow({
  control,
  value,
  onChange,
  onSliderChange,
  onCommit
}: {
  control: InspectorControl;
  value: unknown;
  onChange: (value: unknown) => void;
  onSliderChange: (control: SliderControl, value: number) => void;
  onCommit: (controlId: string) => void;
}) {
  if (control.kind === "slider") {
    return (
      <SliderRow
        control={control}
        value={Number(value)}
        onChange={(nextValue) => onSliderChange(control, nextValue)}
        onCommit={() => onCommit(control.id)}
      />
    );
  }
  if (control.kind === "toggle") {
    return <ToggleRow control={control} value={Boolean(value)} onChange={onChange} />;
  }
  if (control.kind === "color") {
    return <ColorRow control={control} value={String(value)} onChange={onChange} />;
  }
  if (control.kind === "bezier") {
    return (
      <BezierRow
        control={control}
        value={coerceBezierValue(value, control.defaultValue)}
        onChange={onChange}
      />
    );
  }
  if (control.kind === "spring") {
    return (
      <SpringRow
        control={control}
        value={coerceSpringValue(value, control.defaultValue)}
        onChange={onChange}
      />
    );
  }
  if (control.kind === "trigger") {
    return <TriggerRow control={control} onChange={onChange} />;
  }
  return null;
}

function SliderRow({
  control,
  value,
  onChange,
  onCommit
}: {
  control: SliderControl;
  value: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="controlRow">
      <label htmlFor={control.id}>{control.label}</label>
      <div className="sliderGrid">
        <input
          id={control.id}
          min={control.min}
          max={control.max}
          step={control.step ?? 1}
          type="range"
          value={value}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          onKeyUp={onCommit}
          onPointerUp={onCommit}
        />
        <output>
          {value}
          {control.unit ?? ""}
        </output>
      </div>
    </div>
  );
}

function ToggleRow({
  control,
  value,
  onChange
}: {
  control: ToggleControl;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="controlRow inline">
      <label htmlFor={control.id}>{control.label}</label>
      <input
        id={control.id}
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </div>
  );
}

function ColorRow({
  control,
  value,
  onChange
}: {
  control: ColorControl;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="controlRow inline">
      <label htmlFor={control.id}>{control.label}</label>
      <input
        id={control.id}
        type="color"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function TriggerRow({
  control,
  onChange
}: {
  control: TriggerControl;
  onChange: (value: number) => void;
}) {
  return (
    <div className="controlRow inline">
      <div>
        <label>{control.label}</label>
        {control.description ? <p className="controlDescription">{control.description}</p> : null}
      </div>
      <button
        className="triggerButton"
        type="button"
        onClick={() => onChange(Date.now())}
      >
        Run
      </button>
    </div>
  );
}

function SpringRow({
  control,
  value,
  onChange
}: {
  control: SpringControl;
  value: SpringValue;
  onChange: (value: SpringValue) => void;
}) {
  const ranges = {
    damping: control.ranges?.damping ?? [1, 40],
    stiffness: control.ranges?.stiffness ?? [20, 400],
    mass: control.ranges?.mass ?? [0.2, 4]
  };

  return (
    <div className="controlRow springControl">
      <label>{control.label}</label>
      {control.description ? <p className="controlDescription">{control.description}</p> : null}
      <SpringParameter
        label="Damping"
        max={ranges.damping[1]}
        min={ranges.damping[0]}
        step={0.5}
        value={value.damping}
        onChange={(nextValue) => onChange({ ...value, damping: nextValue })}
      />
      <SpringParameter
        label="Stiffness"
        max={ranges.stiffness[1]}
        min={ranges.stiffness[0]}
        step={1}
        value={value.stiffness}
        onChange={(nextValue) => onChange({ ...value, stiffness: nextValue })}
      />
      <SpringParameter
        label="Mass"
        max={ranges.mass[1]}
        min={ranges.mass[0]}
        step={0.1}
        value={value.mass ?? control.defaultValue.mass ?? 1}
        onChange={(nextValue) => onChange({ ...value, mass: nextValue })}
      />
    </div>
  );
}

function BezierRow({
  control,
  value,
  onChange
}: {
  control: BezierControl;
  value: CubicBezier;
  onChange: (value: CubicBezier) => void;
}) {
  return (
    <div className="controlRow bezierControl">
      <label>{control.label}</label>
      {control.description ? <p className="controlDescription">{control.description}</p> : null}
      <BezierPreview value={value} />
      {(["x1", "y1", "x2", "y2"] as const).map((label, index) => (
        <SpringParameter
          key={label}
          label={label}
          max={1}
          min={0}
          step={0.01}
          value={value[index]}
          onChange={(nextValue) => {
            const nextBezier = [...value] as CubicBezier;
            nextBezier[index] = nextValue;
            onChange(nextBezier);
          }}
        />
      ))}
    </div>
  );
}

function BezierPreview({ value }: { value: CubicBezier }) {
  const [x1, y1, x2, y2] = value;
  const start = { x: 12, y: 88 };
  const end = { x: 148, y: 12 };
  const controlA = { x: 12 + x1 * 136, y: 88 - y1 * 76 };
  const controlB = { x: 12 + x2 * 136, y: 88 - y2 * 76 };
  const path = `M ${start.x} ${start.y} C ${controlA.x} ${controlA.y}, ${controlB.x} ${controlB.y}, ${end.x} ${end.y}`;

  return (
    <svg className="bezierPreview" viewBox="0 0 160 100" role="img" aria-label="Bezier curve preview">
      <line className="bezierGuide" x1={start.x} x2={controlA.x} y1={start.y} y2={controlA.y} />
      <line className="bezierGuide" x1={end.x} x2={controlB.x} y1={end.y} y2={controlB.y} />
      <path className="bezierCurve" d={path} />
      <circle className="bezierPoint" cx={controlA.x} cy={controlA.y} r="4" />
      <circle className="bezierPoint" cx={controlB.x} cy={controlB.y} r="4" />
    </svg>
  );
}

function SpringParameter({
  label,
  max,
  min,
  step,
  value,
  onChange
}: {
  label: string;
  max: number;
  min: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="springParameter">
      <span>{label}</span>
      <input
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output>{formatNumber(value)}</output>
    </div>
  );
}

function collectInitialValues(schema: PanelSchema) {
  return Object.fromEntries(
    schema.groups.flatMap((controlGroup) =>
      controlGroup.controls
        .filter(isValueControl)
        .map((control) => [control.id, control.value ?? control.defaultValue])
    )
  );
}

function getControlValue(control: InspectorControl, values: Record<string, unknown>) {
  if (!isValueControl(control)) return undefined;
  return values[control.id] ?? control.defaultValue;
}

function coerceSpringValue(value: unknown, fallback: SpringValue): SpringValue {
  if (!value || typeof value !== "object") return fallback;

  const candidate = value as Partial<SpringValue>;
  return {
    damping:
      typeof candidate.damping === "number" ? candidate.damping : fallback.damping,
    stiffness:
      typeof candidate.stiffness === "number"
        ? candidate.stiffness
        : fallback.stiffness,
    mass: typeof candidate.mass === "number" ? candidate.mass : fallback.mass
  };
}

function coerceBezierValue(value: unknown, fallback: CubicBezier): CubicBezier {
  if (!Array.isArray(value) || value.length !== 4) return fallback;
  if (!value.every((part) => typeof part === "number")) return fallback;
  return value as CubicBezier;
}

function isPatchValueValid(control: InspectorControl, value: unknown) {
  switch (control.kind) {
    case "slider":
      return typeof value === "number" && Number.isFinite(value);
    case "toggle":
      return typeof value === "boolean";
    case "color":
      return typeof value === "string";
    case "bezier":
      return (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((part) => typeof part === "number" && Number.isFinite(part))
      );
    case "spring":
      return Boolean(coerceOptionalSpringValue(value));
    case "trigger":
      return true;
  }
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function sendPatchThrottled(
  schemaId: string,
  controlId: string,
  value: unknown,
  socketRef: RefObject<WebSocket | null>,
  pendingPatchesRef: RefObject<Map<string, PendingPatch>>
) {
  const pendingPatches = pendingPatchesRef.current;
  const existing = pendingPatches.get(controlId);
  const now = performance.now();

  if (!existing || now - existing.lastSentAt >= sliderThrottleMs) {
    existing?.timer && window.clearTimeout(existing.timer);
    sendPatch(schemaId, controlId, value, socketRef);
    pendingPatches.set(controlId, {
      controlId,
      value,
      timer: undefined,
      lastSentAt: now
    });
    return;
  }

  if (existing.timer) {
    window.clearTimeout(existing.timer);
  }

  existing.value = value;
  existing.timer = window.setTimeout(() => {
    sendPatch(schemaId, controlId, existing.value, socketRef);
    pendingPatches.set(controlId, {
      controlId,
      value: existing.value,
      timer: undefined,
      lastSentAt: performance.now()
    });
  }, sliderThrottleMs - (now - existing.lastSentAt));
}

function flushPendingPatch(
  schemaId: string,
  controlId: string,
  socketRef: RefObject<WebSocket | null>,
  pendingPatchesRef: RefObject<Map<string, PendingPatch>>
) {
  const pendingPatches = pendingPatchesRef.current;
  const pending = pendingPatches.get(controlId);
  if (!pending) return;

  if (pending.timer) {
    window.clearTimeout(pending.timer);
  }

  sendPatch(schemaId, controlId, pending.value, socketRef);
  pendingPatches.delete(controlId);
}

function clearPendingPatches(pendingPatches: Map<string, PendingPatch>) {
  for (const pending of pendingPatches.values()) {
    if (pending.timer) {
      window.clearTimeout(pending.timer);
    }
  }
  pendingPatches.clear();
}

function sendPatch(
  schemaId: string,
  controlId: string,
  value: unknown,
  socketRef: RefObject<WebSocket | null>
) {
  if (socketRef.current?.readyState === WebSocket.OPEN) {
    socketRef.current.send(JSON.stringify(createPatch(schemaId, controlId, value)));
  }
}

function sendBatchPatch(
  schemaId: string,
  snapshot: Record<string, unknown>,
  socketRef: RefObject<WebSocket | null>
) {
  if (socketRef.current?.readyState !== WebSocket.OPEN) return;

  socketRef.current.send(
    JSON.stringify({
      type: "control.batchPatch",
      schemaId,
      source: "preset",
      timestamp: Date.now(),
      patches: Object.entries(snapshot).map(([controlId, value]) => ({
        controlId,
        value
      }))
    })
  );
}

function findReplayTrigger(schema: PanelSchema) {
  return schema.groups
    .flatMap((controlGroup) => controlGroup.controls)
    .find(
      (control): control is TriggerControl =>
        control.kind === "trigger" &&
        (control.id.toLowerCase().includes("replay") ||
          Boolean(control.binding?.toLowerCase().includes("replay")))
    );
}

function createTypeScriptPreset(schema: PanelSchema, values: Record<string, unknown>) {
  const variableName = toCamelCase(`${schema.id}Preset`);
  const lines = [
    `export const ${variableName} = ${JSON.stringify(values, null, 2)} as const;`
  ];

  const spring = coerceOptionalSpringValue(values.spring);
  if (spring) {
    lines.push(
      "",
      `export const ${variableName}Spring = ${JSON.stringify(spring, null, 2)} as const;`,
      `// withSpring(targetValue, ${variableName}Spring)`
    );
  }

  const easing = coerceOptionalBezierValue(values.easing);
  if (easing) {
    lines.push(
      "",
      `export const ${variableName}Easing = Easing.bezier(${easing
        .map((part) => formatNumber(part))
        .join(", ")});`
    );
  }

  if (spring || easing) {
    lines.push("", `// import { Easing, withSpring } from "react-native-reanimated";`);
  }

  return lines.join("\n");
}

function coerceOptionalSpringValue(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SpringValue>;
  if (typeof candidate.damping !== "number") return undefined;
  if (typeof candidate.stiffness !== "number") return undefined;
  return {
    damping: candidate.damping,
    stiffness: candidate.stiffness,
    ...(typeof candidate.mass === "number" ? { mass: candidate.mass } : {})
  };
}

function coerceOptionalBezierValue(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((part) => typeof part === "number")) return undefined;
  return value as CubicBezier;
}

function toCamelCase(input: string) {
  const parts = input
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/);

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

createRoot(document.getElementById("root")!).render(<App />);
