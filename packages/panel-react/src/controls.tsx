import { useMemo, type ReactElement } from "react";
import { sampleSpringCurve } from "@runtime-inspector/panel-core";
import type {
  BezierControl,
  ColorControl,
  CubicBezier,
  InspectorControl,
  SliderControl,
  SpringControl,
  SpringValue,
  ToggleControl,
  TriggerControl
} from "@runtime-inspector/protocol";

export function ControlRow({
  control,
  disabled = false,
  value,
  onChange,
  onSliderChange,
  onCommit,
  onApplyToCode
}: {
  control: InspectorControl;
  disabled?: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  onSliderChange: (control: SliderControl, value: number) => void;
  onCommit: (controlId: string) => void;
  onApplyToCode?: (controlId: string) => void;
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
          onClick={() => onApplyToCode?.(control.id)}
        >
          Apply to code
        </button>
      ) : null}
    </div>
  );
}

export function SliderRow({
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

export function ToggleRow({
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

export function ColorRow({
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

export function TriggerRow({
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

export function SpringRow({
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

export function BezierRow({
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

export function BezierPreview({ value }: { value: CubicBezier }) {
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

export function SpringPreview({ value }: { value: SpringValue }) {
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

export function SpringParameter({
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

export function coerceSpringValue(value: unknown, fallback: SpringValue): SpringValue {
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

export function coerceBezierValue(value: unknown, fallback: CubicBezier): CubicBezier {
  if (!Array.isArray(value) || value.length !== 4) return fallback;
  if (!value.every((part) => typeof part === "number")) return fallback;
  return value as CubicBezier;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
