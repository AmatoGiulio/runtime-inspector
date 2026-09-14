import { useEffect, useMemo, useState } from "react";
import { useRozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import {
  createPanelSession,
  type PanelSession,
  type PanelState
} from "@runtime-inspector/panel-core";
import type {
  BezierControl,
  InspectorControl,
  PanelSchema,
  SpringControl
} from "@runtime-inspector/protocol";
import {
  RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
  type RuntimeInspectorRozeniteEvents
} from "./shared";
import { createRozenitePanelSocket } from "./transport";
import "./styles.css";

export default function RuntimeInspectorPanel() {
  const client = useRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>({
    pluginId: RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID
  });
  const [session, setSession] = useState<PanelSession | null>(null);
  const [state, setState] = useState<PanelState | null>(null);
  const [selectedSchemaId, setSelectedSchemaId] = useState<string | undefined>();

  useEffect(() => {
    if (!client) return;
    const nextSession = createPanelSession({
      url: "rozenite://runtime-inspector",
      clientId: "runtime-inspector-rozenite-panel",
      createSocket: () => createRozenitePanelSocket(client)
    });
    setSession(nextSession);
    setState(nextSession.getState());
    const unsubscribe = nextSession.subscribe(setState);
    nextSession.connect();

    return () => {
      unsubscribe();
      nextSession.dispose();
      setSession(null);
      setState(null);
    };
  }, [client]);

  useEffect(() => {
    if (!state?.schemas.length) {
      setSelectedSchemaId(undefined);
      return;
    }
    if (!selectedSchemaId || !state.schemas.some((schema) => schema.id === selectedSchemaId)) {
      setSelectedSchemaId(state.schemas[0]?.id);
    }
  }, [state?.schemas, selectedSchemaId]);

  if (!client || !session || !state) {
    return <div className="ri-empty">Connecting Runtime Inspector to React Native…</div>;
  }

  const schema = state.schemas.find((candidate) => candidate.id === selectedSchemaId);

  return (
    <main className="ri-shell">
      <header className="ri-header">
        <div>
          <div className="ri-eyebrow">Runtime Inspector</div>
          <h1>Live runtime controls</h1>
        </div>
        <ConnectionBadge state={state} />
      </header>

      {state.notice ? <div className="ri-notice">{state.notice}</div> : null}

      {state.schemas.length > 1 ? (
        <nav className="ri-tabs" aria-label="Runtime schemas">
          {state.schemas.map((candidate) => (
            <button
              key={candidate.id}
              className={candidate.id === selectedSchemaId ? "active" : ""}
              onClick={() => setSelectedSchemaId(candidate.id)}
            >
              {candidate.title}
              {state.staleSchemaIds[candidate.id] ? <span className="ri-stale-dot" /> : null}
            </button>
          ))}
        </nav>
      ) : null}

      {schema ? (
        <SchemaView session={session} state={state} schema={schema} />
      ) : (
        <div className="ri-empty">No Runtime Inspector schema has been published yet.</div>
      )}
    </main>
  );
}

function ConnectionBadge({ state }: { state: PanelState }) {
  const staleCount = Object.keys(state.staleSchemaIds).length;
  const label = staleCount > 0 ? `${staleCount} stale` : state.status;
  return <span className={`ri-status ri-status-${staleCount ? "stale" : state.status}`}>{label}</span>;
}

function SchemaView({
  session,
  state,
  schema
}: {
  session: PanelSession;
  state: PanelState;
  schema: PanelSchema;
}) {
  const stale = Boolean(state.staleSchemaIds[schema.id]);
  const values = state.values[schema.id] ?? {};
  const [exportText, setExportText] = useState<string | null>(null);
  const compare = state.compareSlots[schema.id] ?? {};

  return (
    <section className={stale ? "ri-schema stale" : "ri-schema"}>
      <div className="ri-schema-heading">
        <div>
          <h2>{schema.title}</h2>
          <code>{schema.id}</code>
        </div>
        <div className="ri-toolbar">
          <button onClick={() => session.saveCompareSlot("A", schema.id)}>Save A</button>
          <button disabled={!compare.A || stale} onClick={() => session.applyCompareSlot("A", schema.id)}>Apply A</button>
          <button onClick={() => session.saveCompareSlot("B", schema.id)}>Save B</button>
          <button disabled={!compare.B || stale} onClick={() => session.applyCompareSlot("B", schema.id)}>Apply B</button>
          <button onClick={() => setExportText(session.exportTypeScript(schema.id))}>Copy as code</button>
        </div>
      </div>

      {stale ? <div className="ri-stale-banner">Runtime reloaded or disconnected. Controls stay visible but are frozen until this schema is published again.</div> : null}

      {schema.groups.map((group) => (
        <section className="ri-group" key={group.id}>
          <div className="ri-group-heading">
            <h3>{group.label}</h3>
            {group.description ? <p>{group.description}</p> : null}
          </div>
          <div className="ri-controls">
            {group.controls.map((control) => (
              <ControlRow
                key={control.id}
                session={session}
                schemaId={schema.id}
                control={control}
                value={values[control.id]}
                disabled={stale}
              />
            ))}
          </div>
        </section>
      ))}

      {exportText ? (
        <div className="ri-export">
          <div className="ri-export-heading">
            <strong>TypeScript preset</strong>
            <button onClick={() => void navigator.clipboard?.writeText(exportText)}>Copy</button>
            <button onClick={() => setExportText(null)}>Close</button>
          </div>
          <pre>{exportText}</pre>
        </div>
      ) : null}
    </section>
  );
}

function ControlRow({
  session,
  schemaId,
  control,
  value,
  disabled
}: {
  session: PanelSession;
  schemaId: string;
  control: InspectorControl;
  value: unknown;
  disabled: boolean;
}) {
  const current = value ?? ("defaultValue" in control ? control.defaultValue : undefined);

  if (control.kind === "slider") {
    const numericValue = typeof current === "number" ? current : control.defaultValue;
    return (
      <Row label={control.label} value={`${formatNumber(numericValue)}${control.unit ?? ""}`}>
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step ?? "any"}
          value={numericValue}
          disabled={disabled}
          onChange={(event) => session.setValue(schemaId, control.id, Number(event.currentTarget.value))}
          onPointerUp={() => session.commitValue(schemaId, control.id)}
          onKeyUp={() => session.commitValue(schemaId, control.id)}
        />
      </Row>
    );
  }

  if (control.kind === "toggle") {
    return (
      <Row label={control.label} value={Boolean(current) ? "On" : "Off"}>
        <input
          type="checkbox"
          checked={Boolean(current)}
          disabled={disabled}
          onChange={(event) => {
            session.setValue(schemaId, control.id, event.currentTarget.checked);
            session.commitValue(schemaId, control.id);
          }}
        />
      </Row>
    );
  }

  if (control.kind === "color") {
    const color = typeof current === "string" ? current : control.defaultValue;
    return (
      <Row label={control.label} value={color}>
        <input
          type="color"
          value={color}
          disabled={disabled}
          onInput={(event) => session.setValue(schemaId, control.id, event.currentTarget.value)}
          onChange={() => session.commitValue(schemaId, control.id)}
        />
      </Row>
    );
  }

  if (control.kind === "trigger") {
    return (
      <Row label={control.label}>
        <button className="ri-trigger" disabled={disabled} onClick={() => session.fireTrigger(schemaId, control.id)}>
          Run
        </button>
      </Row>
    );
  }

  if (control.kind === "spring") {
    return <SpringEditor session={session} schemaId={schemaId} control={control} value={current} disabled={disabled} />;
  }

  return <BezierEditor session={session} schemaId={schemaId} control={control} value={current} disabled={disabled} />;
}

function SpringEditor({ session, schemaId, control, value, disabled }: {
  session: PanelSession;
  schemaId: string;
  control: SpringControl;
  value: unknown;
  disabled: boolean;
}) {
  const spring = isSpring(value) ? value : control.defaultValue;
  const entries = useMemo(() => Object.entries(spring), [spring]);
  return (
    <div className="ri-composite">
      <div className="ri-composite-title">{control.label}<span>spring</span></div>
      <div className="ri-grid">
        {entries.map(([key, number]) => (
          <label key={key}>{key}
            <input
              type="number"
              value={number}
              disabled={disabled}
              onChange={(event) => session.setValue(schemaId, control.id, { ...spring, [key]: Number(event.currentTarget.value) })}
              onBlur={() => session.commitValue(schemaId, control.id)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function BezierEditor({ session, schemaId, control, value, disabled }: {
  session: PanelSession;
  schemaId: string;
  control: BezierControl;
  value: unknown;
  disabled: boolean;
}) {
  const bezier = isBezier(value) ? value : control.defaultValue;
  return (
    <div className="ri-composite">
      <div className="ri-composite-title">{control.label}<span>cubic bezier</span></div>
      <div className="ri-grid ri-grid-four">
        {bezier.map((number, index) => (
          <label key={index}>p{index + 1}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={number}
              disabled={disabled}
              onChange={(event) => {
                const next = [...bezier] as [number, number, number, number];
                next[index] = Number(event.currentTarget.value);
                session.setValue(schemaId, control.id, next);
              }}
              onBlur={() => session.commitValue(schemaId, control.id)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, children }: { label: string; value?: string; children: React.ReactNode }) {
  return <div className="ri-row"><div><strong>{label}</strong>{value ? <span>{value}</span> : null}</div><div className="ri-row-control">{children}</div></div>;
}

function isSpring(value: unknown): value is SpringControl["defaultValue"] {
  return Boolean(value && typeof value === "object" && "damping" in value && "stiffness" in value);
}

function isBezier(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number");
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
