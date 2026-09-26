import { useMemo, useState, useSyncExternalStore } from "react";
import { createPanelSession } from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";
import { InspectorControlRow } from "@runtime-inspector/panel-dialkit";
import "@runtime-inspector/panel-dialkit/styles.css";
import { createRoot } from "react-dom/client";
import "./styles.css";

type CompareSlot = "A" | "B";

const brokerUrl = import.meta.env.VITE_RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const panelToken =
  new URLSearchParams(window.location.search).get("token") ?? import.meta.env.VITE_RI_TOKEN;

const session = createPanelSession({
  url: brokerUrl,
  token: panelToken,
  clientId: "panel-web"
});
session.connect();

function App() {
  const state = useSyncExternalStore(session.subscribe, session.getState);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Runtime Inspector</h1>
          <p>
            {state.notice ??
              (state.schemas.length > 0
                ? `${state.schemas.length} schema${state.schemas.length === 1 ? "" : "s"} published`
                : "Waiting for runtime schema")}
          </p>
        </div>
        <div className="topbarMeta">
          {state.lastPatch ? (
            <span className="metaText">
              Last patch: {state.lastPatch.label} {state.lastPatch.at}
            </span>
          ) : null}
          <span className={`status ${state.status}`}>{state.status}</span>
        </div>
      </header>

      {state.schemas.length === 0 ? (
        <section className="empty">
          <h2>No schema published</h2>
          <p>Start a React Native runtime and call definePanel().connect().</p>
        </section>
      ) : (
        state.schemas.map((schema) => <SchemaSection key={schema.id} schema={schema} state={state} />)
      )}
    </main>
  );
}

function SchemaSection({ schema, state }: { schema: PanelSchema; state: ReturnType<typeof session.getState> }) {
  const [copied, setCopied] = useState(false);

  const values = state.values[schema.id] ?? {};
  const isStale = Boolean(state.staleSchemaIds[schema.id]);

  const preset = useMemo(() => {
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
    return session.exportTypeScript(schema.id);
  }, [schema, values]);

  const controlStats = useMemo(() => {
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

  async function copyCode() {
    if (!codeExport) return;
    await navigator.clipboard.writeText(codeExport);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function saveCompareSlot(slot: CompareSlot) {
    session.saveCompareSlot(slot, schema.id);
  }

  function applyCompareSlot(slot: CompareSlot) {
    session.applyCompareSlot(slot, schema.id);
  }

  return (
    <section className="schemaSection">
      <div className="schemaSectionHeader">
        <h2>{schema.title}</h2>
        <span className="metaText">
          {controlStats.live} live / {controlStats.advanced} replay
        </span>
        {isStale ? <span className="status disconnected">stale</span> : null}
      </div>
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
                  <InspectorControlRow
                    session={session}
                    schemaId={schema.id}
                    control={control}
                    disabled={isStale}
                    key={control.id}
                    value={values[control.id]}
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
                hasSnapshot={!isStale && Boolean(state.compareSlots[schema.id]?.A)}
                label="A"
                onApply={() => applyCompareSlot("A")}
                onSave={() => saveCompareSlot("A")}
              />
              <CompareSlotControls
                hasSnapshot={!isStale && Boolean(state.compareSlots[schema.id]?.B)}
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
    </section>
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

createRoot(document.getElementById("root")!).render(<App />);
