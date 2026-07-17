import { useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { createPanelSession, sampleSpringCurve } from "@runtime-inspector/panel-core";
import {
  type BezierControl,
  type ColorControl,
  type CubicBezier,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
  type SourceApplyResultEntry,
  type SpringControl,
  type SpringValue,
  type ToggleControl,
  type TriggerControl
} from "@runtime-inspector/protocol";
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
              (state.lastApplyResult
                ? formatApplyResults(state.lastApplyResult.results)
                : state.schemas.length > 0
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

  function applySourceForControl(controlId: string) {
    session.applySource(schema.id, [controlId]);
  }

  function applyAllSource() {
    session.applySource(schema.id);
  }

  const hasAnchoredControl = useMemo(() => schemaHasAnchoredControl(schema), [schema]);

  return (
    <section className="schemaSection">
      <div className="schemaSectionHeader">
        <h2>{schema.title}</h2>
        <span className="metaText">
          {controlStats.live} live / {controlStats.advanced} replay
        </span>
        {isStale ? <span className="status disconnected">stale</span> : null}
        {hasAnchoredControl ? (
          <button className="applyAllButton" type="button" onClick={applyAllSource}>
            Apply all to code
          </button>
        ) : null}
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
                  <ControlRow
                    control={control}
                    disabled={isStale}
                    key={control.id}
                    value={getControlValue(control, values)}
                    onChange={(value) => updateValue(control, value)}
                    onSliderChange={updateSliderValue}
                    onCommit={flushControl}
                    onApplySource={applySourceForControl}
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
                hasSnapshot={Boolean(state.compareSlots[schema.id]?.A)}
                label="A"
                onApply={() => applyCompareSlot("A")}
                onSave={() => saveCompareSlot("A")}
              />
              <CompareSlotControls
                hasSnapshot={Boolean(state.compareSlots[schema.id]?.B)}
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

function ControlRow({
  control,
  disabled = false,
  value,
  onChange,
  onSliderChange,
  onCommit,
  onApplySource
}: {
  control: InspectorControl;
  disabled?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  onSliderChange: (control: SliderControl, value: number) => void;
  onCommit: (controlId: string) => void;
  onApplySource: (controlId: string) => void;
}) {
  let row: ReactElement | null = null;

  if (control.kind === "slider") {
    row = (
      <SliderRow
        control={control}
        disabled={disabled}
        value={Number(value)}
        onChange={(nextValue) => onSliderChange(control, nextValue)}
        onCommit={() => onCommit(control.id)}
      />
    );
  } else if (control.kind === "toggle") {
    row = <ToggleRow control={control} disabled={disabled} value={Boolean(value)} onChange={onChange} />;
  } else if (control.kind === "color") {
    row = <ColorRow control={control} disabled={disabled} value={String(value)} onChange={onChange} />;
  } else if (control.kind === "bezier") {
    row = (
      <BezierRow
        control={control}
        disabled={disabled}
        value={coerceBezierValue(value, control.defaultValue)}
        onChange={onChange}
      />
    );
  } else if (control.kind === "spring") {
    row = (
      <SpringRow
        control={control}
        disabled={disabled}
        value={coerceSpringValue(value, control.defaultValue)}
        onChange={onChange}
      />
    );
  } else if (control.kind === "trigger") {
    row = <TriggerRow control={control} disabled={disabled} onChange={onChange} />;
  }

  if (!row) return null;

  const canApplySource = control.kind !== "trigger" && Boolean(control.source);

  return (
    <div className="controlRowContainer">
      {row}
      {canApplySource ? (
        <button
          className="applyToCodeButton"
          disabled={disabled}
          type="button"
          onClick={() => onApplySource(control.id)}
        >
          Apply to code
        </button>
      ) : null}
    </div>
  );
}

function SliderRow({
  control,
  disabled = false,
  value,
  onChange,
  onCommit
}: {
  control: SliderControl;
  disabled?: boolean;
  value: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="controlRow">
      <label htmlFor={control.id}>{control.label}</label>
      <div className="sliderGrid">
        <input
          disabled={disabled}
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
  disabled = false,
  value,
  onChange
}: {
  control: ToggleControl;
  disabled?: boolean;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="controlRow inline">
      <label htmlFor={control.id}>{control.label}</label>
      <input
        disabled={disabled}
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
  disabled = false,
  value,
  onChange
}: {
  control: ColorControl;
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="controlRow inline">
      <label htmlFor={control.id}>{control.label}</label>
      <input
        disabled={disabled}
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
  disabled = false,
  onChange
}: {
  control: TriggerControl;
  disabled?: boolean;
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
        disabled={disabled}
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
  disabled = false,
  value,
  onChange
}: {
  control: SpringControl;
  disabled?: boolean;
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
      <SpringPreview value={value} />
      <SpringParameter
        disabled={disabled}
        label="Damping"
        max={ranges.damping[1]}
        min={ranges.damping[0]}
        step={0.5}
        value={value.damping}
        onChange={(nextValue) => onChange({ ...value, damping: nextValue })}
      />
      <SpringParameter
        disabled={disabled}
        label="Stiffness"
        max={ranges.stiffness[1]}
        min={ranges.stiffness[0]}
        step={1}
        value={value.stiffness}
        onChange={(nextValue) => onChange({ ...value, stiffness: nextValue })}
      />
      <SpringParameter
        disabled={disabled}
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
  disabled = false,
  value,
  onChange
}: {
  control: BezierControl;
  disabled?: boolean;
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
          disabled={disabled}
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

function SpringPreview({ value }: { value: SpringValue }) {
  const curve = useMemo(() => sampleSpringCurve(value), [value]);

  const xs = curve.points.map((p) => p.x);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(1, ...xs);
  const span = maxX - minX;
  const padding = span * 0.06;
  const rangeMin = minX - padding;
  const rangeMax = maxX + padding;

  const mapX = (t: number) => 4 + (t / curve.duration) * (156 - 4);
  const mapY = (x: number) => 96 - ((x - rangeMin) / (rangeMax - rangeMin)) * (96 - 4);

  const path = curve.points
    .map((p, index) => `${index === 0 ? "M" : "L"} ${mapX(p.t)} ${mapY(p.x)}`)
    .join(" ");

  const guideY = mapY(1);

  return (
    <svg className="springPreview" viewBox="0 0 160 100" role="img" aria-label="Spring curve preview">
      <line className="springGuide" x1={4} x2={156} y1={guideY} y2={guideY} />
      <path className="springCurve" d={path} />
      <text className="springDuration" x={156} y={14} textAnchor="end">
        {curve.duration.toFixed(2)}s
      </text>
    </svg>
  );
}

function SpringParameter({
  disabled = false,
  label,
  max,
  min,
  step,
  value,
  onChange
}: {
  disabled?: boolean;
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
        disabled={disabled}
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

function getControlValue(control: InspectorControl, values: Record<string, unknown>) {
  if (control.kind === "trigger") return undefined;
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

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatApplyEntry(entry: SourceApplyResultEntry): string {
  if (entry.ok) return `${entry.controlId} → ${entry.written} written`;
  return `${entry.controlId}: ${entry.code}${entry.message ? ` — ${entry.message}` : ""}`;
}

function formatApplyResults(results: SourceApplyResultEntry[]): string {
  return results.map(formatApplyEntry).join(" · ");
}

function schemaHasAnchoredControl(schema: PanelSchema): boolean {
  return schema.groups.some((group) =>
    group.controls.some((control) => control.kind !== "trigger" && Boolean(control.source))
  );
}

createRoot(document.getElementById("root")!).render(<App />);
