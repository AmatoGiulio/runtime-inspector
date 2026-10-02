import type {
  PanelSession,
  RuntimeAnimationTrace
} from "@runtime-inspector/panel-core";
import type { InspectorControl } from "@runtime-inspector/protocol";
import { InspectorControlRow } from "@runtime-inspector/panel-dialkit";
import { DialKitScope } from "./DialKitScope";

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
  playheadMs: number;
  /** Editable parameters (delay, duration, spring literals, config control), in display order. */
  controls: AnimationInspectorControl[];
  session: Pick<PanelSession, "setValue" | "commitValue" | "fireTrigger">;
}

export function AnimationInspector({
  animation,
  originMs,
  playheadMs,
  controls,
  session
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
  // A spring control edits the literal spring keys, so they are not listed read-only.
  const editableKeys = new Set(controls.map((entry) => entry.key));
  if (controls.some((entry) => entry.control.kind === "spring")) {
    for (const key of ["damping", "stiffness", "mass"]) editableKeys.add(key);
  }
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

      {readOnlyParameters.length > 0 ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Parameters</div>
          {readOnlyParameters.map(([key, value]) => (
            <InspectorRow key={key} label={humanize(key)} value={String(value)} />
          ))}
        </div>
      ) : null}

      {controls.length > 0 ? (
        <div className="animation-inspector-section">
          <div className="animation-inspector-section-title">Parameters</div>
          <DialKitScope>
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
          <div className="animation-inspector-note">Applies on the next replay.</div>
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