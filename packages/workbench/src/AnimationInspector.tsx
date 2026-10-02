import type {
  PanelSession,
  RuntimeAnimationTrace
} from "@runtime-inspector/panel-core";
import type { InspectorControl, SpringValue } from "@runtime-inspector/protocol";
import { InspectorControlRow, SpringPreview } from "@runtime-inspector/panel-dialkit";
import { DialKitScope } from "./DialKitScope";
import { splitAnimationTarget } from "./timeline-model";

export interface AnimationInspectorControl {
  key: string;
  schemaId: string;
  control: InspectorControl;
  value: unknown;
  disabled: boolean;
}

interface AnimationInspectorProps {
  animation: RuntimeAnimationTrace;
  originMs: number;
  /** Editable parameters (delay, duration, spring literals, config control), in display order. */
  controls: AnimationInspectorControl[];
  /** Spring curve to draw above the parameters; undefined for timing, or when a spring control draws its own. */
  springPreview?: SpringValue;
  session: Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">;
  theme: "light" | "dark";
}

export function AnimationInspector({
  animation,
  originMs,
  controls,
  springPreview,
  session,
  theme
}: AnimationInspectorProps) {
  const startMs = animation.startedAtRuntimeMs - originMs;
  const durationMs =
    animation.endedAtRuntimeMs !== undefined
      ? Math.max(0, animation.endedAtRuntimeMs - animation.startedAtRuntimeMs)
      : animation.expectedDurationMs;
  const estimated =
    animation.endedAtRuntimeMs === undefined &&
    animation.durationBasis === "spring-estimate";
  // A spring control edits the literal spring keys, so they are not listed read-only.
  const editableKeys = new Set(controls.map((entry) => entry.key));
  if (controls.some((entry) => entry.control.kind === "spring")) {
    for (const key of ["damping", "stiffness", "mass"]) editableKeys.add(key);
  }
  const readOnlyParameters = Object.entries(animation.resolvedConfig).filter(
    ([key]) => !editableKeys.has(key)
  );
  const { group, label } = splitAnimationTarget(animation.target);
  const summary = [
    `starts ${formatTime(startMs)}`,
    ...(durationMs !== undefined
      ? [`${estimated ? "~" : ""}${formatTime(durationMs)}`]
      : [])
  ].join(" · ");
  const source = animation.source;

  return (
    <div className="animation-inspector">
      <div className="animation-inspector-head">
        <div className="animation-inspector-name">
          {capitalize(group)} · {label}
        </div>
        <div className="animation-inspector-summary">
          <span>{animation.animationKind === "spring" ? "Spring" : "Timing"}</span>
          <span className="animation-inspector-numbers">
            {summary}
            {animation.toValue !== undefined ? ` → ${formatUnknown(animation.toValue)}` : ""}
          </span>
        </div>
      </div>

      {springPreview || controls.length > 0 ? (
        <div className="animation-inspector-section">
          <DialKitScope theme={theme}>
            {springPreview ? <SpringPreview value={springPreview} /> : null}
            {controls.map((entry) => (
              <InspectorControlRow
                key={`${animation.callsiteId}:${entry.key}`}
                session={session}
                schemaId={entry.schemaId}
                control={entry.control}
                value={entry.value}
                disabled={entry.disabled}
              />
            ))}
          </DialKitScope>
          {controls.length > 0 ? (
            <div className="animation-inspector-note">Applies on the next replay.</div>
          ) : null}
        </div>
      ) : null}

      {readOnlyParameters.length > 0 ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Other</div>
          {readOnlyParameters.map(([key, value]) => (
            <InspectorRow key={key} label={humanize(key)} value={String(value)} />
          ))}
        </div>
      ) : null}

      {source ? (
        <div className="animation-inspector-section animation-inspector-source">
          <div
            className="animation-inspector-location"
            title={`${source.file}:${source.line}`}
          >
            {fileBasename(source.file)}:{source.line}
          </div>
          {source.expression ? (
            <details className="animation-source-details">
              <summary className="wb-button toggle animation-source-toggle">Code</summary>
              <code className="animation-source-expression">{source.expression}</code>
            </details>
          ) : null}
        </div>
      ) : null}
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

function capitalize(input: string): string {
  return input.replace(/^./, (character) => character.toUpperCase());
}

function fileBasename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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