import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import {
  animationDisplayEnd,
  animationTargetLabel,
  buildTimelineModel,
  clamp,
  resizedDurationMs
} from "./timeline-model";

export interface AnimationTimelineProps {
  animations: RuntimeAnimationTrace[];
  selectedAnimationId?: string;
  playheadMs: number;
  /** True while a replay's animations are expected to be running; drives the self-running playhead. */
  playing?: boolean;
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
  selectedAnimationId,
  playheadMs,
  playing = false,
  onSelectAnimation,
  onPlayheadChange,
  getDurationRange,
  onResizeDuration
}: AnimationTimelineProps) {
  const model = useMemo(() => buildTimelineModel(animations), [animations]);
  const dragRef = useRef(false);
  const resizeRef = useRef<ResizeSession | undefined>(undefined);
  const [resize, setResize] = useState<ResizeState | undefined>(undefined);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );

  // Running playhead: local to this component so the parent is not re-rendered every frame.
  const [runningMs, setRunningMs] = useState<number | undefined>(undefined);
  const runFrameRef = useRef<number | undefined>(undefined);
  const durationRef = useRef(model.durationMs);
  durationRef.current = model.durationMs;
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  onPlayheadChangeRef.current = onPlayheadChange;
  const hasAnimations = animations.length > 0;

  useEffect(() => {
    if (!playing || !hasAnimations) return;

    const startedAtWallClock = performance.now();
    const step = () => {
      const elapsed = performance.now() - startedAtWallClock;
      const durationMs = durationRef.current;
      if (elapsed >= durationMs) {
        runFrameRef.current = undefined;
        setRunningMs(undefined);
        onPlayheadChangeRef.current(durationMs);
        return;
      }
      setRunningMs(elapsed);
      runFrameRef.current = requestAnimationFrame(step);
    };
    step();

    return () => {
      if (runFrameRef.current !== undefined) {
        cancelAnimationFrame(runFrameRef.current);
        runFrameRef.current = undefined;
      }
      setRunningMs(undefined);
    };
  }, [playing, hasAnimations, model.originMs]);

  if (!hasAnimations) return null;

  const displayPlayheadMs = clamp(runningMs ?? playheadMs, 0, model.durationMs);
  const playheadPercent = (displayPlayheadMs / Math.max(1, model.durationMs)) * 100;
  const percentOf = (ms: number) => `${(ms / model.durationMs) * 100}%`;

  function cancelRun() {
    if (runFrameRef.current !== undefined) {
      cancelAnimationFrame(runFrameRef.current);
      runFrameRef.current = undefined;
    }
    setRunningMs(undefined);
  }

  function pointerTime(event: ReactPointerEvent<HTMLElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * model.durationMs;
  }

  function updatePlayhead(event: ReactPointerEvent<HTMLElement>) {
    onPlayheadChange(pointerTime(event));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>) {
    cancelRun();
    dragRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updatePlayhead(event);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current || (event.buttons & 1) === 0) return;
    updatePlayhead(event);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!dragRef.current) return;
    dragRef.current = false;
    updatePlayhead(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const scrubHandlers = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp
  };

  function toggleGroup(groupId: string) {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (!next.delete(groupId)) next.add(groupId);
      return next;
    });
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
    const lane = event.currentTarget.closest(".motion-row-lane");
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

  const gridLines = model.ticks.map((tick) => (
    <span
      className="motion-grid-line"
      key={tick}
      style={{ left: percentOf(tick) }}
    />
  ));

  return (
    <div className="motion-timeline">
      <div className="motion-timeline-grid">
        <div className="motion-playhead-overlay" aria-hidden="true">
          <span
            className="motion-playhead"
            style={{ left: `${playheadPercent}%` }}
          />
        </div>

        <div className="motion-ruler-row">
          <div className="motion-ruler-label">
            <span>{formatSeconds(displayPlayheadMs)}</span>
          </div>
          <div className="motion-ruler" {...scrubHandlers}>
            {model.ticks.map((tick, index) => (
              <div
                className={classNames(
                  "motion-ruler-tick",
                  index > 0 && index === model.ticks.length - 1 && "last"
                )}
                key={tick}
                style={{ left: percentOf(tick) }}
              >
                <span>{formatTime(tick)}</span>
              </div>
            ))}
            {model.minorTicks.map((tick) => (
              <span
                className="motion-ruler-dot"
                key={tick}
                style={{ left: percentOf(tick) }}
              />
            ))}
            <span
              className="motion-playhead-marker"
              aria-hidden="true"
              style={{ left: `${playheadPercent}%` }}
            >
              {/* Slides from left-aligned (0%) to right-aligned (100%) so the pill never leaves the ruler. */}
              <span
                className="motion-playhead-pill"
                style={{ transform: `translateX(-${playheadPercent}%)` }}
              >
                {formatSeconds(displayPlayheadMs)}
              </span>
            </span>
          </div>
        </div>

        {model.groups.map((group) => {
          const collapsed = collapsedGroupIds.has(group.id);

          return (
            <div className="motion-group" key={group.id}>
              <div
                className="motion-group-row"
                onClick={() => toggleGroup(group.id)}
              >
                <div className="motion-group-label">
                  {/* The row's click handler toggles; a keyboard activation of this button bubbles to it. */}
                  <button
                    className="motion-group-toggle"
                    type="button"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  >
                    {collapsed ? "▸" : "▾"}
                  </button>
                  <span className="motion-group-name">{group.label}</span>
                </div>
                <div className="motion-group-lane">{gridLines}</div>
              </div>

              {collapsed
                ? null
                : group.rows.map((row) => {
                    const { animation, startMs } = row;
                    const durationRange = onResizeDuration
                      ? getDurationRange?.(animation)
                      : undefined;
                    const resizing =
                      resize?.instanceId === animation.instanceId
                        ? resize
                        : undefined;
                    const displayDuration =
                      resizing?.durationMs ?? row.durationMs;
                    const endMs =
                      resizing !== undefined
                        ? startMs + resizing.durationMs
                        : animationDisplayEnd(animation) - model.originMs;
                    const selected =
                      animation.instanceId === selectedAnimationId;

                    return (
                      <div
                        className={classNames(
                          "motion-row",
                          selected && "selected",
                          resizing && "resizing"
                        )}
                        key={animation.instanceId}
                      >
                        <button
                          className="motion-row-label"
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onSelectAnimation(animation.instanceId)}
                        >
                          <KindGlyph spring={animation.animationKind === "spring"} />
                          <span className="motion-row-name">{row.label}</span>
                          <span className="motion-row-kind">· {row.kindLabel}</span>
                          <span className="motion-row-duration">
                            {displayDuration !== undefined
                              ? `${row.estimated && !resizing ? "~" : ""}${formatTime(
                                  displayDuration
                                )}`
                              : "—"}
                          </span>
                        </button>
                        <div className="motion-row-lane" {...scrubHandlers}>
                          {gridLines}
                          <button
                            className={classNames(
                              "motion-bar",
                              row.estimated && !resizing && "estimated",
                              selected && "selected"
                            )}
                            type="button"
                            aria-label={`${row.label} · ${row.kindLabel}`}
                            style={{
                              left: percentOf(startMs),
                              width: `${Math.max(
                                0.8,
                                ((endMs - startMs) / model.durationMs) * 100
                              )}%`
                            }}
                            title={animationSpanTitle(
                              animation,
                              displayDuration,
                              row.estimated
                            )}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectAnimation(animation.instanceId);
                            }}
                          />
                          {durationRange ? (
                            <span
                              className={classNames(
                                "motion-bar-resize",
                                (selected || resizing) && "active"
                              )}
                              aria-hidden="true"
                              style={{
                                left: `calc(${percentOf(endMs)} - 4px)`
                              }}
                              onPointerDown={(event) =>
                                handleResizePointerDown(
                                  event,
                                  animation,
                                  startMs,
                                  row.durationMs,
                                  durationRange
                                )
                              }
                              onPointerMove={handleResizePointerMove}
                              onPointerUp={handleResizePointerUp}
                              onPointerCancel={handleResizePointerCancel}
                              onClick={(event) => event.stopPropagation()}
                            />
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KindGlyph({ spring }: { spring: boolean }) {
  return (
    <svg
      className="motion-row-glyph"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
    >
      <path
        d={
          spring
            ? "M1 10 C2.5 10 2.5 2 4.5 2 S6 8 7.5 8 S8.5 5 9.5 5 H11"
            : "M1 10 C5 10 7 2 11 2"
        }
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
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

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}
