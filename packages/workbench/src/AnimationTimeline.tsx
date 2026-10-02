import {
  Fragment,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import {
  activeAnimationAtTime,
  animationDisplayEnd,
  animationTargetLabel,
  buildTimelineModel,
  clamp,
  resizedDurationMs,
  type AnimationPropertyTrack
} from "./timeline-model";

export interface AnimationTimelineProps {
  animations: RuntimeAnimationTrace[];
  interactionScoped: boolean;
  selectedAnimationId?: string;
  playheadMs: number;
  onSelectAnimation(animationId: string): void;
  onPlayheadChange(ms: number): void;
  /** Returns the editable range for a span's duration, or undefined when the span cannot be resized. */
  getDurationRange?(
    animation: RuntimeAnimationTrace
  ): { min: number; max: number; step: number } | undefined;
  /** Fired once, on pointer release, when a resize ended on a duration different from the current one. */
  onResizeDuration?(animationId: string, durationMs: number): void;
}

interface ResizeState {
  instanceId: string;
  durationMs: number;
}

interface ResizeSession extends ResizeState {
  startMs: number;
  currentDurationMs: number | undefined;
  range: { min: number; max: number; step: number };
}

export function AnimationTimeline({
  animations,
  interactionScoped,
  selectedAnimationId,
  playheadMs,
  onSelectAnimation,
  onPlayheadChange,
  getDurationRange,
  onResizeDuration
}: AnimationTimelineProps) {
  const model = useMemo(() => buildTimelineModel(animations), [animations]);
  const dragRef = useRef(false);
  const resizeRef = useRef<ResizeSession | undefined>(undefined);
  const [resize, setResize] = useState<ResizeState | undefined>(undefined);

  if (animations.length === 0) return null;

  const clampedPlayhead = clamp(playheadMs, 0, model.durationMs);
  const playheadPercent = (clampedPlayhead / Math.max(1, model.durationMs)) * 100;

  function pointerTime(event: ReactPointerEvent<HTMLElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * model.durationMs;
  }

  function updateRulerPlayhead(event: ReactPointerEvent<HTMLElement>) {
    onPlayheadChange(pointerTime(event));
  }

  function updateTrackPlayhead(
    event: ReactPointerEvent<HTMLElement>,
    track: AnimationPropertyTrack
  ) {
    const timeMs = pointerTime(event);
    onPlayheadChange(timeMs);

    const active = activeAnimationAtTime(track.animations, model.originMs, timeMs);
    if (active && active.instanceId !== selectedAnimationId) {
      onSelectAnimation(active.instanceId);
    }
  }

  function handlePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    update: (event: ReactPointerEvent<HTMLElement>) => void
  ) {
    dragRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    update(event);
  }

  function handlePointerMove(
    event: ReactPointerEvent<HTMLElement>,
    update: (event: ReactPointerEvent<HTMLElement>) => void
  ) {
    if (!dragRef.current || (event.buttons & 1) === 0) return;
    update(event);
  }

  function handlePointerUp(
    event: ReactPointerEvent<HTMLElement>,
    update: (event: ReactPointerEvent<HTMLElement>) => void
  ) {
    if (!dragRef.current) return;
    dragRef.current = false;
    update(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    animation: RuntimeAnimationTrace,
    startMs: number,
    currentDurationMs: number | undefined,
    range: { min: number; max: number; step: number }
  ) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectAnimation(animation.instanceId);
    const initial = currentDurationMs ?? range.min;
    resizeRef.current = {
      instanceId: animation.instanceId,
      durationMs: initial,
      startMs,
      currentDurationMs,
      range
    };
    setResize({ instanceId: animation.instanceId, durationMs: initial });
  }

  function handleResizePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = resizeRef.current;
    if (!session) return;
    event.stopPropagation();
    const lane = event.currentTarget.closest(".motion-property-lane");
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const durationMs = resizedDurationMs({
      startMs: session.startMs,
      pointerMs: ratio * model.durationMs,
      ...session.range
    });
    if (durationMs === session.durationMs) return;
    session.durationMs = durationMs;
    setResize({ instanceId: session.instanceId, durationMs });
  }

  function handleResizePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const session = resizeRef.current;
    if (!session) return;
    event.stopPropagation();
    resizeRef.current = undefined;
    setResize(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (session.durationMs !== session.currentDurationMs) {
      onResizeDuration?.(session.instanceId, session.durationMs);
    }
  }

  function handleResizePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (!resizeRef.current) return;
    event.stopPropagation();
    resizeRef.current = undefined;
    setResize(undefined);
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

      <div className="motion-timeline-grid">
        <div className="motion-playhead-overlay" aria-hidden="true">
          <Playhead percent={playheadPercent} />
        </div>

        <div className="motion-ruler-row">
          <div className="motion-ruler-label">
            <span>{formatTime(clampedPlayhead)}</span>
          </div>
          <div
            className="motion-ruler"
            onPointerDown={(event) =>
              handlePointerDown(event, updateRulerPlayhead)
            }
            onPointerMove={(event) =>
              handlePointerMove(event, updateRulerPlayhead)
            }
            onPointerUp={(event) =>
              handlePointerUp(event, updateRulerPlayhead)
            }
            onPointerCancel={(event) =>
              handlePointerUp(event, updateRulerPlayhead)
            }
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
          </div>
        </div>

        {model.tracks.map((track) => {
          const updateTrack = (event: ReactPointerEvent<HTMLElement>) =>
            updateTrackPlayhead(event, track);

          return (
            <div className="motion-property-row" key={track.target}>
              <div className="motion-property-label">
                <strong>{track.label}</strong>
              </div>
              <div
                className="motion-property-lane"
                onPointerDown={(event) =>
                  handlePointerDown(event, updateTrack)
                }
                onPointerMove={(event) =>
                  handlePointerMove(event, updateTrack)
                }
                onPointerUp={(event) =>
                  handlePointerUp(event, updateTrack)
                }
                onPointerCancel={(event) =>
                  handlePointerUp(event, updateTrack)
                }
              >
                {model.ticks.map((tick) => (
                  <span
                    className="motion-grid-line"
                    key={tick}
                    style={{ left: `${(tick / model.durationMs) * 100}%` }}
                  />
                ))}

                {track.animations.map((animation) => {
                  const startMs =
                    animation.startedAtRuntimeMs - model.originMs;
                  const durationRange = onResizeDuration
                    ? getDurationRange?.(animation)
                    : undefined;
                  const resizing =
                    resize?.instanceId === animation.instanceId
                      ? resize
                      : undefined;
                  const actualDuration =
                    animation.endedAtRuntimeMs !== undefined
                      ? Math.max(
                          0,
                          animation.endedAtRuntimeMs -
                            animation.startedAtRuntimeMs
                        )
                      : undefined;
                  const currentDuration =
                    actualDuration ?? animation.expectedDurationMs;
                  const displayDuration =
                    resizing?.durationMs ?? currentDuration;
                  const endMs =
                    resizing !== undefined
                      ? startMs + resizing.durationMs
                      : animationDisplayEnd(animation) - model.originMs;
                  const estimated =
                    actualDuration === undefined &&
                    animation.durationBasis === "spring-estimate";
                  const selected =
                    animation.instanceId === selectedAnimationId;

                  return (
                    <Fragment key={animation.instanceId}>
                    <button
                      className={[
                        "motion-span",
                        animation.animationKind,
                        estimated ? "estimated" : "",
                        selected ? "selected" : "",
                        resizing ? "resizing" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      type="button"
                      style={{
                        left: `${(startMs / model.durationMs) * 100}%`,
                        width: `${Math.max(
                          0.8,
                          ((endMs - startMs) / model.durationMs) * 100
                        )}%`
                      }}
                      title={animationSpanTitle(
                        animation,
                        displayDuration,
                        estimated
                      )}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPlayheadChange(startMs);
                        onSelectAnimation(animation.instanceId);
                      }}
                    >
                      <span>
                        {animation.animationKind}
                        {displayDuration !== undefined
                          ? ` · ${estimated ? "~" : ""}${formatTime(
                              displayDuration
                            )}`
                          : ""}
                      </span>
                    </button>
                    {durationRange ? (
                      <span
                        className={[
                          "motion-span-resize",
                          selected || resizing ? "active" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-hidden="true"
                        style={{
                          left: `calc(${(endMs / model.durationMs) * 100}% - 4px)`
                        }}
                        onPointerDown={(event) =>
                          handleResizePointerDown(
                            event,
                            animation,
                            startMs,
                            currentDuration,
                            durationRange
                          )
                        }
                        onPointerMove={handleResizePointerMove}
                        onPointerUp={handleResizePointerUp}
                        onPointerCancel={handleResizePointerCancel}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
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

function formatTime(ms: number): string {
  return ms >= 1000
    ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
    : `${Math.round(ms)}ms`;
}
