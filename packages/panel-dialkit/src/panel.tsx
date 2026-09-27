import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder } from "dialkit";
import type {
  CompareSlotId,
  PanelSession,
  PanelState,
} from "@runtime-inspector/panel-core";
import type {
  PanelSchema,
  SourceApplyResultEntry,
} from "@runtime-inspector/protocol";
import { InspectorControlRow } from "./controls";
import { CheckIcon, ClipboardIcon, CodeIcon } from "./icons";

export type InspectorPanelTheme = "light" | "dark" | "system";

export interface InspectorPanelProps {
  session: PanelSession;
  state: PanelState;
  title?: string;
  theme?: InspectorPanelTheme;
  /**
   * Whether a `workspace` client can receive `source.apply` on this transport.
   * The WebSocket broker routes it to the CLI; direct bridges have no workspace.
   */
  canApplySource?: boolean;
  /** Shown when no schema has been published yet. */
  emptyHint?: ReactNode;
}

/**
 * The complete Runtime Inspector panel, laid out as an inline DialKit panel:
 * one section per schema, one folder per group. Rendering only; every value,
 * stale, comparison and export decision stays in `panel-core`.
 */
export function InspectorPanel({
  session,
  state,
  title = "Runtime Inspector",
  theme = "system",
  canApplySource = false,
  emptyHint,
}: InspectorPanelProps) {
  const message =
    state.notice ??
    (state.lastApplyResult
      ? formatApplyResults(state.lastApplyResult.results)
      : undefined);

  return (
    <div className="dialkit-root ri-panel" data-mode="inline" data-theme={theme}>
      <div className="dialkit-panel" data-mode="inline">
        <div className="dialkit-panel-wrapper">
          <Folder title={title} isRoot inline>
            <div className="ri-panel-status">
              <ConnectionBadge state={state} />
              {message ? (
                <span className="ri-panel-notice" role="status">
                  {message}
                </span>
              ) : null}
            </div>
            {state.schemas.length === 0 ? (
              <div className="ri-panel-empty">
                <strong>Waiting for the app</strong>
                <span>
                  {emptyHint ??
                    "Declare a control with useRuntimeValue, useInspector or // @inspect and it will appear here."}
                </span>
              </div>
            ) : (
              state.schemas.map((schema) => (
                <SchemaSection
                  key={schema.id}
                  session={session}
                  state={state}
                  schema={schema}
                  canApplySource={canApplySource}
                />
              ))
            )}
          </Folder>
        </div>
      </div>
    </div>
  );
}

export function ConnectionBadge({ state }: { state: PanelState }) {
  const staleCount = Object.values(state.staleSchemaIds).filter(Boolean).length;
  const tone = staleCount > 0 ? "stale" : state.status;
  const label = staleCount > 0 ? `${staleCount} stale` : state.status;
  return (
    <span className={`ri-status ri-status-${tone}`}>
      <span className="ri-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function SchemaSection({
  session,
  state,
  schema,
  canApplySource,
}: {
  session: PanelSession;
  state: PanelState;
  schema: PanelSchema;
  canApplySource: boolean;
}) {
  const stale = Boolean(state.staleSchemaIds[schema.id]);
  const values = state.values[schema.id] ?? {};
  const compare = state.compareSlots[schema.id] ?? {};
  const [showCode, setShowCode] = useState(false);
  const copied = useFlag();
  const anchored = canApplySource && schemaHasAnchoredControl(schema);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(session.exportTypeScript(schema.id));
      copied.raise();
    } catch {
      setShowCode(true);
    }
  }

  const toolbar = (
    <>
      <button
        type="button"
        className="dialkit-toolbar-add"
        onClick={copyCode}
        title="Copy values as TypeScript"
        aria-label={`Copy ${schema.title} values as TypeScript`}
      >
        {copied.on ? <CheckIcon /> : <ClipboardIcon />}
      </button>
      {anchored ? (
        <button
          type="button"
          className="dialkit-toolbar-add"
          disabled={stale}
          onClick={() => session.applySource(schema.id)}
          title="Write every anchored value back to source"
          aria-label={`Apply all ${schema.title} values to code`}
        >
          <CodeIcon />
        </button>
      ) : null}
    </>
  );

  const body = (
    <div
      className="ri-schema"
      data-stale={stale || undefined}
      data-writeback={anchored || undefined}
    >
      {stale ? (
        <div className="ri-stale-banner">
          Runtime reloaded or disconnected — frozen until it publishes again.
        </div>
      ) : null}
      {schema.groups.map((group) => (
        <Folder key={group.id} title={group.label} defaultOpen>
          {group.controls.map((control) => (
            <InspectorControlRow
              key={control.id}
              session={session}
              schemaId={schema.id}
              control={control}
              value={values[control.id]}
              disabled={stale}
              onApplyToCode={
                canApplySource && control.kind !== "trigger" && control.source
                  ? () => session.applySource(schema.id, [control.id])
                  : undefined
              }
            />
          ))}
        </Folder>
      ))}
      <Folder title="Compare" defaultOpen={false}>
        {(["A", "B"] as CompareSlotId[]).map((slot) => (
          <div className="dialkit-labeled-control ri-compare-slot" key={slot}>
            <span className="dialkit-labeled-control-label">
              Snapshot {slot}
            </span>
            <div className="ri-compare-actions">
              <button
                type="button"
                className="dialkit-button"
                aria-label={`Save snapshot ${slot}`}
                onClick={() => session.saveCompareSlot(slot, schema.id)}
              >
                Save
              </button>
              <button
                type="button"
                className="dialkit-button"
                aria-label={`Apply snapshot ${slot}`}
                disabled={!compare[slot] || stale}
                onClick={() => session.applyCompareSlot(slot, schema.id)}
              >
                Apply
              </button>
            </div>
          </div>
        ))}
      </Folder>
      <div className="dialkit-button-group">
        <button
          type="button"
          className="dialkit-button"
          aria-expanded={showCode}
          onClick={() => setShowCode((open) => !open)}
        >
          {showCode ? "Hide code" : "Show code"}
        </button>
      </div>
      {showCode ? (
        <pre className="ri-code">{session.exportTypeScript(schema.id)}</pre>
      ) : null}
    </div>
  );

  return (
    <Folder title={schema.title} defaultOpen toolbar={toolbar}>
      {body}
    </Folder>
  );
}

function useFlag(duration = 1200) {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    on,
    raise() {
      setOn(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOn(false), duration);
    },
  };
}

export function formatApplyResults(results: SourceApplyResultEntry[]): string {
  return results
    .map((entry) =>
      entry.ok
        ? `${entry.controlId} → ${entry.written} written`
        : `${entry.controlId}: ${entry.code}${entry.message ? ` — ${entry.message}` : ""}`,
    )
    .join(" · ");
}

function schemaHasAnchoredControl(schema: PanelSchema): boolean {
  return schema.groups.some((group) =>
    group.controls.some(
      (control) => control.kind !== "trigger" && Boolean(control.source),
    ),
  );
}
