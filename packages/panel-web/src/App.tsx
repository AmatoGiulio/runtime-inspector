import { useEffect, useMemo, useRef, useState } from "react";
import {
  RIP_VERSION,
  createPatch,
  isValueControl,
  type ColorControl,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
  type ToggleControl
} from "@runtime-inspector/protocol";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ConnectionState = "connecting" | "connected" | "disconnected";
const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";

function App() {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [schema, setSchema] = useState<PanelSchema>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [copied, setCopied] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let closedByReact = false;

    const connect = () => {
      setStatus("connecting");
      const socket = new WebSocket(brokerUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        setStatus("connected");
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
        if (!closedByReact) {
          reconnectTimer = window.setTimeout(connect, 1000);
        }
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "schema.publish") {
          setSchema(message.schema);
          setValues(collectInitialValues(message.schema));
        }
        if (message.type === "control.patch") {
          setValues((current) => ({ ...current, [message.controlId]: message.value }));
        }
      };
    };

    connect();

    return () => {
      closedByReact = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
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
    setValues((current) => ({ ...current, [control.id]: value }));
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(createPatch(schema.id, control.id, value)));
    }
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
          <p>{schema ? schema.title : "Waiting for runtime schema"}</p>
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
  onChange
}: {
  control: InspectorControl;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (control.kind === "slider") {
    return <SliderRow control={control} value={Number(value)} onChange={onChange} />;
  }
  if (control.kind === "toggle") {
    return <ToggleRow control={control} value={Boolean(value)} onChange={onChange} />;
  }
  if (control.kind === "color") {
    return <ColorRow control={control} value={String(value)} onChange={onChange} />;
  }
  return (
    <div className="controlRow">
      <label>{control.label}</label>
      <span className="unsupported">{control.kind}</span>
    </div>
  );
}

function SliderRow({
  control,
  value,
  onChange
}: {
  control: SliderControl;
  value: number;
  onChange: (value: number) => void;
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
