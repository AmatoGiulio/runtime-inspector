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
}

export function AnimationInspector({
  animation,
  originMs,
  playheadMs,
  springControl,
  springValue,
  stale,
  onSetSpring,
  onCommitSpring
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

      {Object.keys(animation.resolvedConfig).length > 0 && !canTuneSpring ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Parameters</div>
          {Object.entries(animation.resolvedConfig).map(([key, value]) => (
            <InspectorRow key={key} label={humanize(key)} value={String(value)} />
          ))}
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