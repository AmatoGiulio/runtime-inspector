import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  RIP_VERSION,
  createPatch,
  isValueControl,
  type ColorControl,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
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

const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const sliderThrottleMs = 50;

function App() {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [schema, setSchema] = useState<PanelSchema>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string>();
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
        let message: { type?: string; [key: string]: unknown };

        try {
          message = JSON.parse(String(event.data));
        } catch {
          setNotice("Ignored invalid JSON message from broker.");
          return;
        }

        if (message.type === "schema.publish") {
          const nextSchema = message.schema as PanelSchema;
          setSchema(nextSchema);
          setValues(collectInitialValues(nextSchema));
          setNotice(undefined);
        }
        if (message.type === "control.patch") {
          if (typeof message.controlId !== "string") {
            setNotice("Ignored invalid control patch from broker.");
            return;
          }
          const controlId = message.controlId;
          setValues((current) => ({ ...current, [controlId]: message.value }));
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

  function updateValue(control: InspectorControl, value: unknown) {
    if (!schema) return;
    if (isValueControl(control)) {
      setValues((current) => ({ ...current, [control.id]: value }));
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(createPatch(schema.id, control.id, value)));
    }
  }

  function updateSliderValue(control: SliderControl, value: number) {
    if (!schema) return;
    setValues((current) => ({ ...current, [control.id]: value }));
    sendPatchThrottled(schema.id, control.id, value, socketRef, pendingPatchesRef);
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Runtime Inspector</h1>
          <p>{notice ?? (schema ? schema.title : "Waiting for runtime schema")}</p>
        </div>
        <span className={`status ${status}`}>{status}</span>
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
                  <h2>{controlGroup.label}</h2>
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

function createTypeScriptPreset(schema: PanelSchema, values: Record<string, unknown>) {
  const variableName = toCamelCase(`${schema.id}Preset`);
  return `export const ${variableName} = ${JSON.stringify(values, null, 2)} as const;`;
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
