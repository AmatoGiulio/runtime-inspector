import { ConnectionBadge } from "./connection-badge";
import { useEffect, useState } from "react";
import { useRozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import {
  createPanelSession,
  type PanelSession,
  type PanelState
} from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";
import { InspectorControlRow } from "@runtime-inspector/panel-dialkit";
import "@runtime-inspector/panel-dialkit/styles.css";
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
    const unsubscribe = nextSession.subscribe(() => setState(nextSession.getState()));
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
        <SchemaView key={schema.id} session={session} state={state} schema={schema} />
      ) : (
        <div className="ri-empty">No Runtime Inspector schema has been published yet.</div>
      )}
    </main>
  );
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
              <InspectorControlRow
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

