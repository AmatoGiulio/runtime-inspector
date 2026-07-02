import { useEffect, useMemo, useRef, useState } from "react";
import {
  RIP_VERSION,
  createPatch,
  type ColorControl,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
  type ToggleControl
} from "@runtime-inspector/protocol";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ConnectionState = "connecting" | "connected" | "disconnected";

function App() {
  const [status, setStatus] = useState<ConnectionState>("connecting");
  const [schema, setSchema] = useState<PanelSchema>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const socket = new WebSocket(import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577");
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

    socket.onclose = () => setStatus("disconnected");
    socket.onerror = () => setStatus("disconnected");
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

    return () => socket.close();
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

  function updateValue(control: InspectorControl, value: unknown) {
    if (!schema) return;
    setValues((current) => ({ ...current, [control.id]: value }));
    socketRef.current?.send(JSON.stringify(createPatch(schema.id, control.id, value)));
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
                      value={values[control.id] ?? control.defaultValue}
                      onChange={(value) => updateValue(control, value)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
          <aside className="preset">
            <h2>Preset JSON</h2>
            <pre>{preset}</pre>
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
      controlGroup.controls.map((control) => [
        control.id,
        control.value ?? control.defaultValue
      ])
    )
  );
}

createRoot(document.getElementById("root")!).render(<App />);
