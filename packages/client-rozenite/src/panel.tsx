import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { createPanelSession, type PanelSession } from "@runtime-inspector/panel-core";
import { ControlRow } from "@runtime-inspector/panel-react";
import type { InspectorControl, PanelSchema, SliderControl } from "@runtime-inspector/protocol";
import "@runtime-inspector/panel-react/styles.css";
import "./panel.css";

const BROKER_URL_STORAGE_KEY = "runtime-inspector.rozenite.brokerUrl";
const TOKEN_STORAGE_KEY = "runtime-inspector.rozenite.token";
const DEFAULT_BROKER_URL = "ws://127.0.0.1:4577";

function readStoredValue(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStoredValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframe) —
    // connecting still works, it just won't be remembered next time.
  }
}

/**
 * Runtime Inspector's Rozenite DevTools panel.
 *
 * This connects directly to the Runtime Inspector broker over WebSocket —
 * the same broker the app's runtime SDK talks to — using
 * `@runtime-inspector/panel-core`'s `createPanelSession`, exactly like the
 * standalone `panel-web` client does. See `react-native.ts` for why this
 * plugin doesn't use `@rozenite/plugin-bridge`.
 */
export default function RuntimeInspectorPanel() {
  const [brokerUrl, setBrokerUrl] = useState(() => readStoredValue(BROKER_URL_STORAGE_KEY, DEFAULT_BROKER_URL));
  const [token, setToken] = useState(() => readStoredValue(TOKEN_STORAGE_KEY, ""));
  const [session, setSession] = useState<PanelSession | null>(null);

  const state = useSyncExternalStore(
    session ? session.subscribe : noopSubscribe,
    session ? session.getState : getDisconnectedState
  );

  const connect = useCallback(() => {
    writeStoredValue(BROKER_URL_STORAGE_KEY, brokerUrl);
    writeStoredValue(TOKEN_STORAGE_KEY, token);
    session?.dispose();
    const nextSession = createPanelSession({
      url: brokerUrl,
      token: token || undefined,
      clientId: "client-rozenite"
    });
    nextSession.connect();
    setSession(nextSession);
  }, [brokerUrl, token, session]);

  return (
    <div className="riRozeniteRoot">
      <form
        className="riConnectForm"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        <label>
          Broker URL
          <input
            onChange={(event) => setBrokerUrl(event.target.value)}
            placeholder={DEFAULT_BROKER_URL}
            type="text"
            value={brokerUrl}
          />
        </label>
        <label>
          Token
          <input
            onChange={(event) => setToken(event.target.value)}
            placeholder="session token"
            type="text"
            value={token}
          />
        </label>
        <button type="submit">Connect</button>
        <span className={`status ${state.status}`}>{state.status}</span>
        {state.notice ? <span className="metaText">{state.notice}</span> : null}
      </form>

      {session ? (
        <div className="riSchemaList">
          {state.schemas.length === 0 ? (
            <section className="empty">
              <h2>No schema published</h2>
              <p>Start a React Native runtime and call definePanel().connect().</p>
            </section>
          ) : (
            state.schemas.map((schema) => (
              <SchemaSection key={schema.id} schema={schema} session={session} state={state} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function noopSubscribe() {
  return () => {};
}

function getDisconnectedState() {
  return DISCONNECTED_STATE;
}

const DISCONNECTED_STATE = {
  status: "disconnected" as const,
  notice: "Not connected.",
  schemas: [] as PanelSchema[],
  staleSchemaIds: {} as Record<string, boolean>,
  values: {} as Record<string, Record<string, unknown>>,
  compareSlots: {} as Record<string, Partial<Record<"A" | "B", Record<string, unknown>>>>
};

function SchemaSection({
  schema,
  session,
  state
}: {
  schema: PanelSchema;
  session: PanelSession;
  state: ReturnType<PanelSession["getState"]>;
}) {
  const values = state.values[schema.id] ?? {};
  const isStale = Boolean(state.staleSchemaIds[schema.id]);

  const hasAnchoredControl = useMemo(() => schemaHasAnchoredControl(schema), [schema]);

  function updateValue(control: InspectorControl, value: unknown) {
    if (control.kind === "trigger") {
      session.fireTrigger(schema.id, control.id);
      return;
    }
    session.setValue(schema.id, control.id, value);
  }

  function updateSliderValue(control: SliderControl, value: number) {
    session.setValue(schema.id, control.id, value);
  }

  function flushControl(controlId: string) {
    session.commitValue(schema.id, controlId);
  }

  function applySourceForControl(controlId: string) {
    session.applySource(schema.id, [controlId]);
  }

  function applyAllSource() {
    session.applySource(schema.id);
  }

  return (
    <section className="schemaSection">
      <div className="schemaSectionHeader">
        <h2>{schema.title}</h2>
        {isStale ? <span className="status disconnected">stale</span> : null}
        {hasAnchoredControl ? (
          <button className="applyAllButton" onClick={applyAllSource} type="button">
            Apply all to code
          </button>
        ) : null}
      </div>
      <div className="groups">
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
                  disabled={isStale}
                  key={control.id}
                  onApplyToCode={applySourceForControl}
                  onChange={(value) => updateValue(control, value)}
                  onCommit={flushControl}
                  onSliderChange={updateSliderValue}
                  value={getControlValue(control, values)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function getControlValue(control: InspectorControl, values: Record<string, unknown>) {
  if (control.kind === "trigger") return undefined;
  return values[control.id] ?? control.defaultValue;
}

function schemaHasAnchoredControl(schema: PanelSchema): boolean {
  return schema.groups.some((group) =>
    group.controls.some((control) => control.kind !== "trigger" && Boolean(control.source))
  );
}
