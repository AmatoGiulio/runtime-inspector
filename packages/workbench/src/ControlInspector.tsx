import type {
  CubicBezier,
  InspectorControl,
  SpringValue
} from "@runtime-inspector/protocol";

interface ControlInspectorProps {
  control: InspectorControl;
  value: unknown;
  stale: boolean;
  onSet(value: unknown): void;
  onCommit(): void;
  onTrigger(): void;
  onApplySource(): void;
}

export function ControlInspector({
  control,
  value,
  stale,
  onSet,
  onCommit,
  onTrigger,
  onApplySource
}: ControlInspectorProps) {
  const sourceBacked = "source" in control && Boolean(control.source);

  return (
    <div className="control-inspector">
      <div className="control-inspector-head">
        <div>
          <div className="control-inspector-name">{control.label}</div>
          <div className="control-inspector-kind">{control.kind}</div>
        </div>
        {stale ? <span className="control-stale">stale</span> : null}
      </div>

      {control.description ? (
        <div className="control-description">{control.description}</div>
      ) : null}

      <div className="control-editor">
        {control.kind === "slider" ? (
          <SliderEditor
            control={control}
            value={typeof value === "number" ? value : control.value ?? control.defaultValue}
            disabled={stale}
            onSet={onSet}
            onCommit={onCommit}
          />
        ) : null}

        {control.kind === "toggle" ? (
          <ToggleEditor
            value={typeof value === "boolean" ? value : control.value ?? control.defaultValue}
            disabled={stale}
            onSet={(next) => {
              onSet(next);
              queueMicrotask(onCommit);
            }}
          />
        ) : null}

        {control.kind === "color" ? (
          <ColorEditor
            value={typeof value === "string" ? value : control.value ?? control.defaultValue}
            disabled={stale}
            onSet={onSet}
            onCommit={onCommit}
          />
        ) : null}

        {control.kind === "spring" ? (
          <SpringEditor
            control={control}
            value={isSpringValue(value) ? value : control.value ?? control.defaultValue}
            disabled={stale}
            onSet={onSet}
            onCommit={onCommit}
          />
        ) : null}

        {control.kind === "bezier" ? (
          <BezierEditor
            value={isBezier(value) ? value : control.value ?? control.defaultValue}
            disabled={stale}
            onSet={onSet}
            onCommit={onCommit}
          />
        ) : null}

        {control.kind === "trigger" ? (
          <button
            className="control-trigger"
            type="button"
            disabled={stale}
            onClick={onTrigger}
          >
            Run {control.label}
          </button>
        ) : null}
      </div>

      <div className="control-meta">
        <Meta label="Binding" value={control.binding ?? "—"} />
        {"unit" in control ? <Meta label="Unit" value={control.unit ?? "—"} /> : null}
        <Meta label="Source" value={sourceBacked ? "write-back available" : "runtime only"} />
      </div>

      {sourceBacked ? (
        <button
          className="control-apply"
          type="button"
          disabled={stale}
          onClick={onApplySource}
        >
          Apply to code
        </button>
      ) : null}
    </div>
  );
}

function SliderEditor({
  control,
  value,
  disabled,
  onSet,
  onCommit
}: {
  control: Extract<InspectorControl, { kind: "slider" }>;
  value: number;
  disabled: boolean;
  onSet(value: number): void;
  onCommit(): void;
}) {
  const step = control.step ?? Math.max((control.max - control.min) / 100, 0.001);

  return (
    <div className="control-stack">
      <div className="control-value-row">
        <span>Value</span>
        <input
          className="control-number"
          type="number"
          min={control.min}
          max={control.max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onSet(Number(event.target.value))}
          onBlur={onCommit}
          onKeyUp={(event) => {
            if (event.key === "Enter") onCommit();
          }}
        />
      </div>
      <input
        className="control-range"
        type="range"
        min={control.min}
        max={control.max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onSet(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <div className="control-range-ends">
        <span>{formatNumber(control.min)}</span>
        <span>{formatNumber(control.max)}</span>
      </div>
    </div>
  );
}

function ToggleEditor({
  value,
  disabled,
  onSet
}: {
  value: boolean;
  disabled: boolean;
  onSet(value: boolean): void;
}) {
  return (
    <button
      className={value ? "control-toggle active" : "control-toggle"}
      type="button"
      disabled={disabled}
      aria-pressed={value}
      onClick={() => onSet(!value)}
    >
      <span>{value ? "On" : "Off"}</span>
      <span className="control-toggle-track">
        <span className="control-toggle-thumb" />
      </span>
    </button>
  );
}

function ColorEditor({
  value,
  disabled,
  onSet,
  onCommit
}: {
  value: string;
  disabled: boolean;
  onSet(value: string): void;
  onCommit(): void;
}) {
  const canUsePicker = /^#[0-9a-f]{6}$/i.test(value);

  return (
    <div className="control-color-row">
      {canUsePicker ? (
        <input
          className="control-color"
          type="color"
          value={value}
          disabled={disabled}
          onChange={(event) => onSet(event.target.value)}
          onBlur={onCommit}
        />
      ) : null}
      <input
        className="control-text"
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => onSet(event.target.value)}
        onBlur={onCommit}
        onKeyUp={(event) => {
          if (event.key === "Enter") onCommit();
        }}
      />
    </div>
  );
}

function SpringEditor({
  control,
  value,
  disabled,
  onSet,
  onCommit
}: {
  control: Extract<InspectorControl, { kind: "spring" }>;
  value: SpringValue;
  disabled: boolean;
  onSet(value: SpringValue): void;
  onCommit(): void;
}) {
  const fields: Array<{
    key: keyof SpringValue;
    label: string;
    fallback: [number, number];
    step: number;
  }> = [
    { key: "damping", label: "Damping", fallback: [0, 100], step: 0.1 },
    { key: "stiffness", label: "Stiffness", fallback: [1, 1000], step: 1 },
    { key: "mass", label: "Mass", fallback: [0.1, 10], step: 0.1 }
  ];

  return (
    <div className="control-stack">
      {fields.map(({ key, label, fallback, step }) => {
        if (key === "mass" && value.mass === undefined && !control.ranges?.mass) return null;
        const range = control.ranges?.[key] ?? fallback;
        const current = value[key] ?? (key === "mass" ? 1 : 0);

        return (
          <div className="control-subfield" key={key}>
            <div className="control-value-row">
              <span>{label}</span>
              <input
                className="control-number"
                type="number"
                min={range[0]}
                max={range[1]}
                step={step}
                value={current}
                disabled={disabled}
                onChange={(event) => {
                  onSet({ ...value, [key]: Number(event.target.value) });
                }}
                onBlur={onCommit}
                onKeyUp={(event) => {
                  if (event.key === "Enter") onCommit();
                }}
              />
            </div>
            <input
              className="control-range"
              type="range"
              min={range[0]}
              max={range[1]}
              step={step}
              value={current}
              disabled={disabled}
              onChange={(event) => {
                onSet({ ...value, [key]: Number(event.target.value) });
              }}
              onPointerUp={onCommit}
              onKeyUp={onCommit}
            />
          </div>
        );
      })}
    </div>
  );
}

function BezierEditor({
  value,
  disabled,
  onSet,
  onCommit
}: {
  value: CubicBezier;
  disabled: boolean;
  onSet(value: CubicBezier): void;
  onCommit(): void;
}) {
  const labels = ["x1", "y1", "x2", "y2"];

  return (
    <div className="bezier-grid">
      {value.map((part, index) => (
        <label key={labels[index]}>
          <span>{labels[index]}</span>
          <input
            className="control-number"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={part}
            disabled={disabled}
            onChange={(event) => {
              const next = [...value] as CubicBezier;
              next[index] = Number(event.target.value);
              onSet(next);
            }}
            onBlur={onCommit}
            onKeyUp={(event) => {
              if (event.key === "Enter") onCommit();
            }}
          />
        </label>
      ))}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="control-meta-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function isSpringValue(value: unknown): value is SpringValue {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SpringValue>;
  return (
    typeof candidate.damping === "number" &&
    typeof candidate.stiffness === "number" &&
    (candidate.mass === undefined || typeof candidate.mass === "number")
  );
}

function isBezier(value: unknown): value is CubicBezier {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((part) => typeof part === "number" && Number.isFinite(part))
  );
}

function formatNumber(value: number) {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2).replace(/\.00$/, "");
}
