import {
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";

export interface AnimationTimelineProps {
  animations: RuntimeAnimationTrace[];
  interactionScoped: boolean;
  selectedAnimationId?: string;
  playheadMs: number;
  onSelectAnimation(animationId: string): void;
  onPlayheadChange(ms: number): void;
}

interface AnimationPropertyTrack {
  target: string;
  label: string;
  animations: RuntimeAnimationTrace[];
}

export function AnimationTimeline({
  animations,
  interactionScoped,
  selectedAnimationId,
  playheadMs,
  onSelectAnimation,
  onPlayheadChange
}: AnimationTimelineProps) {
  const model = useMemo(() => buildTimelineModel(animations), [animations]);
  const dragRef = useRef(false);

  if (animations.length === 0) return null;

  const clampedPlayhead = clamp(playheadMs, 0, model.durationMs);
  const playheadPercent = (clampedPlayhead / Math.max(1, model.durationMs)) * 100;

  function updatePlayheadFromPointer(event: ReactPointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    onPlayheadChange(ratio * model.durationMs);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    dragRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updatePlayheadFromPointer(event);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current || (event.buttons & 1) === 0) return;
    updatePlayheadFromPointer(event);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return;
    dragRef.current = false;
    updatePlayheadFromPointer(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="motion-timeline">
      <div className="motion-timeline-head">
        <span>
          {interactionScoped ? "Current replay" : "Latest interaction"} · auto-detected
        </span>
        <strong>
          {model.tracks.length} {model.tracks.length === 1 ? "property" : "properties"} ·{" "}
          {animations.length} spans
        </strong>
      </div>

      <div className="motion-ruler-row">
        <div className="motion-ruler-label">
          <span>{formatTime(clampedPlayhead)}</span>
        </div>
        <div
          className="motion-ruler"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {model.ticks.map((tick) => (
            <div
              className="motion-ruler-tick"
              key={tick}
              style={{ left: `${(tick / model.durationMs) * 100}%` }}
            >
              <span>{formatTime(tick)}</span>
            </div>
          ))}
          <Playhead percent={playheadPercent} />
        </div>
      </div>

      {model.tracks.map((track) => (
        <div className="motion-property-row" key={track.target}>
          <div className="motion-property-label">
            <strong>{track.label}</strong>
          </div>
          <div
            className="motion-property-lane"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {model.ticks.map((tick) => (
              <span
                className="motion-grid-line"
                key={tick}
                style={{ left: `${(tick / model.durationMs) * 100}%` }}
              />
            ))}

            {track.animations.map((animation) => {
              const startMs = animation.startedAtRuntimeMs - model.originMs;
              const endMs = animationDisplayEnd(animation) - model.originMs;
              const actualDuration =
                animation.endedAtRuntimeMs !== undefined
                  ? Math.max(
                      0,
                      animation.endedAtRuntimeMs - animation.startedAtRuntimeMs
                    )
                  : undefined;
              const displayDuration = actualDuration ?? animation.expectedDurationMs;
              const estimated =
                actualDuration === undefined &&
                animation.durationBasis === "spring-estimate";
              const selected = animation.instanceId === selectedAnimationId;

              return (
                <button
                  className={[
                    "motion-span",
                    animation.animationKind,
                    estimated ? "estimated" : "",
                    selected ? "selected" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  key={animation.instanceId}
                  type="button"
                  style={{
                    left: `${(startMs / model.durationMs) * 100}%`,
                    width: `${Math.max(
                      0.8,
                      ((endMs - startMs) / model.durationMs) * 100
                    )}%`
                  }}
                  title={animationSpanTitle(animation, displayDuration, estimated)}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectAnimation(animation.instanceId);
                  }}
                >
                  <span>
                    {animation.animationKind}
                    {displayDuration !== undefined
                      ? ` · ${estimated ? "~" : ""}${formatTime(displayDuration)}`
                      : ""}
                  </span>
                </button>
              );
            })}

            <Playhead percent={playheadPercent} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Playhead({ percent }: { percent: number }) {
  return (
    <span className="motion-playhead" style={{ left: `${percent}%` }}>
      <span className="motion-playhead-cap" />
    </span>
  );
}

function buildTimelineModel(animations: RuntimeAnimationTrace[]) {
  const tracks = groupAnimationsByTarget(animations);
  const originMs = Math.min(
    ...animations.map((animation) => animation.startedAtRuntimeMs)
  );
  const maxEndMs = Math.max(
    ...animations.map((animation) => animationDisplayEnd(animation))
  );
  const rawDuration = Math.max(1, maxEndMs - originMs);
  const tickStep = chooseTickStep(rawDuration);
  const durationMs = Math.max(
    tickStep,
    Math.ceil(rawDuration / tickStep) * tickStep
  );
  const ticks: number[] = [];

  for (let tick = 0; tick <= durationMs; tick += tickStep) {
    ticks.push(tick);
  }

  return {
    tracks,
    originMs,
    durationMs,
    ticks
  };
}

function groupAnimationsByTarget(
  animations: RuntimeAnimationTrace[]
): AnimationPropertyTrack[] {
  const tracks = new Map<string, AnimationPropertyTrack>();

  for (const animation of animations) {
    const existing = tracks.get(animation.target);
    if (existing) {
      existing.animations.push(animation);
      continue;
    }

    tracks.set(animation.target, {
      target: animation.target,
      label: animationTargetLabel(animation.target),
      animations: [animation]
    });
  }

  return Array.from(tracks.values()).map((track) => ({
    ...track,
    animations: [...track.animations].sort(
      (left, right) => left.startedAtRuntimeMs - right.startedAtRuntimeMs
    )
  }));
}

function animationTargetLabel(target: string): string {
  const leaf = target.split(".").at(-1) ?? target;
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function animationDisplayEnd(animation: RuntimeAnimationTrace): number {
  if (animation.endedAtRuntimeMs !== undefined) {
    return animation.endedAtRuntimeMs;
  }
  if (animation.expectedDurationMs !== undefined) {
    return animation.startedAtRuntimeMs + animation.expectedDurationMs;
  }
  return animation.startedAtRuntimeMs + 16;
}

function animationSpanTitle(
  animation: RuntimeAnimationTrace,
  duration: number | undefined,
  estimated: boolean
): string {
  return [
    animationTargetLabel(animation.target),
    animation.animationKind +
      (duration !== undefined
        ? ` · ${estimated ? "~" : ""}${formatTime(duration)}`
        : ""),
    animation.source
      ? `${animation.source.file}:${animation.source.line}`
      : animation.callsiteId,
    Object.keys(animation.resolvedConfig).length
      ? Object.entries(animation.resolvedConfig)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(" · ")
      : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function chooseTickStep(durationMs: number): number {
  if (durationMs <= 500) return 100;
  if (durationMs <= 1200) return 200;
  if (durationMs <= 2500) return 500;
  if (durationMs <= 6000) return 1000;
  return 2000;
}

function formatTime(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
