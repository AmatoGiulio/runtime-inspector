import { useRef, useState } from "react";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type { InspectorControl, SpringValue } from "@runtime-inspector/protocol";

interface AnimationInspectorProps {
  animation: RuntimeAnimationTrace;
  originMs: number;
  playheadMs: number;
  springControl?: Extract<InspectorControl, { kind: "spring" }>;
  springValue?: SpringValue;
  stale: boolean;
  onSetSpring?(value: SpringValue): void;
  onCommitSpring?(): void;
  /** Editable numeric parameters (delay, duration, spring literals), in display order. */
  fields?: AnimationField[];
}

export interface AnimationField {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onSet(value: number): void;
  onCommit(): void;
}

export function AnimationInspector({
  animation,
  originMs,
  playheadMs,
  springControl,
  springValue,
  stale,
  onSetSpring,
  onCommitSpring,
  fields = []
}: AnimationInspectorProps) {
  const startMs = animation.startedAtRuntimeMs - originMs;
  const durationMs =
    animation.endedAtRuntimeMs !== undefined
      ? Math.max(0, animation.endedAtRuntimeMs - animation.startedAtRuntimeMs)
      : animation.expectedDurationMs;
  const endMs = durationMs !== undefined ? startMs + durationMs : undefined;
  const playheadState =
    playheadMs < startMs
      ? "before"
      : endMs !== undefined && playheadMs > endMs
        ? "after"
        : "active";
  const estimated =
    animation.endedAtRuntimeMs === undefined &&
    animation.durationBasis === "spring-estimate";
  const canTuneSpring =
    animation.animationKind === "spring" &&
    Boolean(springControl && springValue && onSetSpring && onCommitSpring);
  const editableKeys = new Set(fields.map((field) => field.key));
  const readOnlyParameters = Object.entries(animation.resolvedConfig).filter(
    ([key]) => !editableKeys.has(key)
  );

  return (
    <div className="animation-inspector">
      <div className="animation-inspector-head">
        <div>
          <div className="animation-inspector-name">
            {animationTargetLabel(animation.target)}
          </div>
          <div className="animation-inspector-kind">
            {animation.animationKind}
          </div>
        </div>
        <span className={`animation-playhead-state ${playheadState}`}>
          {playheadState}
        </span>
      </div>

      <div className="animation-inspector-section">
        <InspectorRow label="Starts" value={formatTime(startMs)} />
        <InspectorRow
          label="Duration"
          value={
            durationMs !== undefined
              ? `${estimated ? "~" : ""}${formatTime(durationMs)}`
              : "—"
          }
        />
        <InspectorRow label="At playhead" value={formatTime(playheadMs)} />
        <InspectorRow
          label="Target"
          value={formatUnknown(animation.toValue)}
        />
      </div>

      {readOnlyParameters.length > 0 && !canTuneSpring ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Parameters</div>
          {readOnlyParameters.map(([key, value]) => (
            <InspectorRow key={key} label={humanize(key)} value={String(value)} />
          ))}
        </div>
      ) : null}

      {fields.length > 0 ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Parameters</div>
          <div className="animation-spring-fields">
            {fields.map((field) => (
              <NumberField
                key={`${animation.instanceId}:${field.key}`}
                field={field}
                disabled={stale}
              />
            ))}
          </div>
          <div className="animation-inspector-note">Applies on the next replay.</div>
        </div>
      ) : null}

      {canTuneSpring &&
      springControl &&
      springValue &&
      onSetSpring &&
      onCommitSpring ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Spring</div>
          <SpringFields
            control={springControl}
            value={springValue}
            disabled={stale}
            onSet={onSetSpring}
            onCommit={onCommitSpring}
          />
          <InspectorRow
            label="Estimated settle"
            value={
              durationMs !== undefined
                ? `~${formatTime(durationMs)}`
                : "—"
            }
          />
          {estimated ? (
            <div className="animation-inspector-note">
              Estimated from the current spring parameters; runtime completion is not observed yet.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="animation-inspector-section">
        <div className="animation-inspector-section-title">Source</div>
        <InspectorRow
          label="Location"
          value={
            animation.source
              ? `${animation.source.file}:${animation.source.line}`
              : "—"
          }
        />
        {animation.source?.expression ? (
          <code className="animation-source-expression">
            {animation.source.expression}
          </code>
        ) : null}
      </div>
    </div>
  );
}

function SpringFields({
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
    <div className="animation-spring-fields">
      {fields.map(({ key, label, fallback, step }) => {
        if (key === "mass" && value.mass === undefined && !control.ranges?.mass) {
          return null;
        }

        const range = control.ranges?.[key] ?? fallback;
        const current = value[key] ?? (key === "mass" ? 1 : 0);

        return (
          <label className="animation-spring-field" key={key}>
            <div>
              <span>{label}</span>
              <input
                type="number"
                min={range[0]}
                max={range[1]}
                step={step}
                value={current}
                disabled={disabled}
                onChange={(event) =>
                  onSet({ ...value, [key]: Number(event.target.value) })
                }
                onBlur={onCommit}
                onKeyUp={(event) => {
                  if (event.key === "Enter") onCommit();
                }}
              />
            </div>
            <input
              type="range"
              min={range[0]}
              max={range[1]}
              step={step}
              value={current}
              disabled={disabled}
              onChange={(event) =>
                onSet({ ...value, [key]: Number(event.target.value) })
              }
              onPointerUp={onCommit}
              onKeyUp={onCommit}
            />
          </label>
        );
      })}
    </div>
  );
}

function NumberField({
  field,
  disabled
}: {
  field: AnimationField;
  disabled: boolean;
}) {
  const { label, unit, min, max, step, value, onSet, onCommit } = field;
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const dirtyRef = useRef(false);
  const parsed = draft === undefined ? undefined : parseDraft(draft);
  const invalid =
    draft !== undefined && (parsed === undefined || parsed < min || parsed > max);
  const rangeMax = unit === "ms" ? Math.min(max, Math.max(2000, value * 2)) : max;

  function commit() {
    if (invalid || !dirtyRef.current) return;
    dirtyRef.current = false;
    setDraft(undefined);
    onCommit();
  }

  return (
    <>
      <label className="animation-spring-field">
        <div>
          <span>{label}</span>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft ?? value}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              const text = event.target.value;
              setDraft(text);
              const next = parseDraft(text);
              if (next !== undefined && next >= min && next <= max) {
                dirtyRef.current = true;
                onSet(next);
              }
            }}
            onBlur={commit}
            onKeyUp={(event) => {
              if (event.key === "Enter") commit();
            }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={rangeMax}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setDraft(undefined);
            dirtyRef.current = true;
            onSet(Number(event.target.value));
          }}
          onPointerUp={commit}
          onKeyUp={commit}
        />
      </label>
      {invalid ? (
        <div className="animation-inspector-note" role="alert">
          {label} must be between {min} and {max}
          {unit ? ` ${unit}` : ""}.
        </div>
      ) : null}
    </>
  );
}

function parseDraft(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="animation-inspector-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function animationTargetLabel(target: string): string {
  const leaf = target.split(".").at(-1) ?? target;
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function humanize(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function formatUnknown(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  return String(value);
}

function formatTime(ms: number): string {
  return ms >= 1000
    ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s`
    : `${Math.round(ms)}ms`;
}