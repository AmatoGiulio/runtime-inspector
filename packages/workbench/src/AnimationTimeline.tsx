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
  movedStartDelay,
  resizedDurationMs,
  resizedFromStart
} from "./timeline-model";

/** Pointer travel below this many pixels is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

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
  /** Returns the editable range of a span's start delay, and its current value, or undefined when the span cannot be moved. */
  getStartRange?(
    animation: RuntimeAnimationTrace
  ): { min: number; max: number; step: number; value: number } | undefined;
  /** Fired once, on pointer release, when a move ended on a delay different from the current one. */
  onMoveStart?(animationId: string, delayMs: number): void;
  /** Fired once, on pointer release, when a left-edge drag changed the delay or duration. */
  onResizeStart?(animationId: string, delayMs: number, durationMs: number): void;
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

interface EditState {
  instanceId: string;
  mode: "move" | "resize-start";
  /** Delay the control had when the drag began. */
  baseDelayMs: number;
  /** Previewed delay. */
  delayMs: number;
  /** Previewed duration; set for left-edge drags. */
  durationMs?: number;
}

interface EditSession extends EditState {
  startClientX: number;
  laneWidth: number;
  startMs: number;
  /** Move only: the pointer travelled past the click threshold. */
  dragging: boolean;
  startRange: { min: number; max: number; step: number };
  durationRange?: { min: number; max: number; step: number };
  baseDurationMs?: number;
}

export function AnimationTimeline({
  animations,
  selectedAnimationId,
  playheadMs,
  playing = false,
  onSelectAnimation,
  onPlayheadChange,
  getDurationRange,
  onResizeDuration,
  getStartRange,
  onMoveStart,
  onResizeStart
}: AnimationTimelineProps) {
  const model = useMemo(() => buildTimelineModel(animations), [animations]);
  const dragRef = useRef(false);
  const resizeRef = useRef<ResizeSession | undefined>(undefined);
  const [resize, setResize] = useState<ResizeState | undefined>(undefined);
  const editRef = useRef<EditSession | undefined>(undefined);
  const [edit, setEdit] = useState<EditState | undefined>(undefined);
  /** Set when a move drag ended: the click the browser fires after it must not select again. */
  const suppressClickRef = useRef(false);
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

  function laneWidthOf(element: Element): number {
    return element.closest(".motion-row-lane")?.getBoundingClientRect().width ?? 0;
  }

  function releaseCapture(event: ReactPointerEvent<HTMLElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleBarPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    animation: RuntimeAnimationTrace,
    startMs: number,
    startRange: { min: number; max: number; step: number; value: number }
  ) {
    event.stopPropagation();
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    editRef.current = {
      instanceId: animation.instanceId,
      mode: "move",
      baseDelayMs: startRange.value,
      delayMs: startRange.value,
      startClientX: event.clientX,
      laneWidth: laneWidthOf(event.currentTarget),
      startMs,
      dragging: false,
      startRange
    };
  }

  function handleBarPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current;
    if (!session || session.mode !== "move") return;
    event.stopPropagation();
    const travelPx = event.clientX - session.startClientX;
    if (!session.dragging && Math.abs(travelPx) < DRAG_THRESHOLD_PX) return;
    if (session.laneWidth <= 0) return;
    const deltaMs = clamp(
      (travelPx / session.laneWidth) * model.durationMs,
      -session.startMs,
      model.durationMs - session.startMs
    );
    const delayMs = movedStartDelay({
      delay: session.baseDelayMs,
      deltaMs,
      ...session.startRange
    });
    const wasDragging = session.dragging;
    session.dragging = true;
    if (wasDragging && delayMs === session.delayMs) return;
    session.delayMs = delayMs;
    setEdit({
      instanceId: session.instanceId,
      mode: "move",
      baseDelayMs: session.baseDelayMs,
      delayMs
    });
  }

  function handleBarPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current;
    if (!session || session.mode !== "move") return;
    event.stopPropagation();
    editRef.current = undefined;
    setEdit(undefined);
    releaseCapture(event);
    // Below the threshold this is a click: the click event selects the span.
    if (!session.dragging) return;
    suppressClickRef.current = true;
    if (session.delayMs !== session.baseDelayMs) {
      onSelectAnimation(session.instanceId);
      onMoveStart?.(session.instanceId, session.delayMs);
    }
  }

  function handleBarPointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (editRef.current?.mode !== "move") return;
    event.stopPropagation();
    editRef.current = undefined;
    setEdit(undefined);
    releaseCapture(event);
  }

  function handleStartEdgePointerDown(
    event: ReactPointerEvent<HTMLElement>,
    animation: RuntimeAnimationTrace,
    startMs: number,
    startRange: { min: number; max: number; step: number; value: number },
    durationRange: { min: number; max: number; step: number },
    currentDurationMs: number | undefined
  ) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const baseDurationMs = currentDurationMs ?? durationRange.min;
    editRef.current = {
      instanceId: animation.instanceId,
      mode: "resize-start",
      baseDelayMs: startRange.value,
      delayMs: startRange.value,
      durationMs: baseDurationMs,
      baseDurationMs,
      startClientX: event.clientX,
      laneWidth: laneWidthOf(event.currentTarget),
      startMs,
      dragging: true,
      startRange,
      durationRange
    };
    setEdit({
      instanceId: animation.instanceId,
      mode: "resize-start",
      baseDelayMs: startRange.value,
      delayMs: startRange.value,
      durationMs: baseDurationMs
    });
  }

  function handleStartEdgePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current;
    if (
      !session ||
      session.mode !== "resize-start" ||
      !session.durationRange ||
      session.baseDurationMs === undefined ||
      session.laneWidth <= 0
    ) {
      return;
    }
    event.stopPropagation();
    const deltaMs = clamp(
      ((event.clientX - session.startClientX) / session.laneWidth) *
        model.durationMs,
      -session.startMs,
      model.durationMs - session.startMs
    );
    const next = resizedFromStart({
      delay: session.baseDelayMs,
      duration: session.baseDurationMs,
      deltaMs,
      delayRange: session.startRange,
      durationRange: session.durationRange
    });
    if (next.delay === session.delayMs && next.duration === session.durationMs) {
      return;
    }
    session.delayMs = next.delay;
    session.durationMs = next.duration;
    setEdit({
      instanceId: session.instanceId,
      mode: "resize-start",
      baseDelayMs: session.baseDelayMs,
      delayMs: next.delay,
      durationMs: next.duration
    });
  }

  function handleStartEdgePointerUp(event: ReactPointerEvent<HTMLElement>) {
    const session = editRef.current;
    if (!session || session.mode !== "resize-start") return;
    event.stopPropagation();
    editRef.current = undefined;
    setEdit(undefined);
    releaseCapture(event);
    if (
      session.durationMs !== undefined &&
      (session.delayMs !== session.baseDelayMs ||
        session.durationMs !== session.baseDurationMs)
    ) {
      onSelectAnimation(session.instanceId);
      onResizeStart?.(session.instanceId, session.delayMs, session.durationMs);
    }
  }

  function handleStartEdgePointerCancel(event: ReactPointerEvent<HTMLElement>) {
    if (editRef.current?.mode !== "resize-start") return;
    event.stopPropagation();
    editRef.current = undefined;
    setEdit(undefined);
    releaseCapture(event);
  }

  // Quarter points between the major ticks: DialKit's fine marks. `minorTicks` (midpoints) are its medium marks.
  const fineTicks = model.ticks.slice(1).flatMap((tick, index) => {
    const previous = model.ticks[index]!;
    const step = (tick - previous) / 4;
    return [previous + step, previous + step * 3];
  });

  const gridLines = model.ticks.map((tick) => (
    <span
      className="motion-grid-line"
      key={tick}
      style={{ left: percentOf(tick) }}
    />
  ));

  return (
    <div className="motion-timeline dialkit-timeline-body">
      <div className="motion-timeline-grid dialkit-timeline-grid">
        <div className="motion-playhead-overlay" aria-hidden="true">
          <span
            className="motion-playhead"
            style={{ left: `${playheadPercent}%` }}
          />
        </div>

        <div className="motion-ruler-row dialkit-timeline-row">
          <div className="motion-ruler-label dialkit-timeline-label" />
          <div className="motion-ruler dialkit-timeline-ruler" {...scrubHandlers}>
            {fineTicks.map((tick) => (
              <div
                className="dialkit-timeline-tick dialkit-timeline-tick-fine"
                key={`fine:${tick}`}
                style={{ left: percentOf(tick) }}
              />
            ))}
            {model.minorTicks.map((tick) => (
              <div
                className="dialkit-timeline-tick dialkit-timeline-tick-medium"
                key={`medium:${tick}`}
                style={{ left: percentOf(tick) }}
              />
            ))}
            {model.ticks.map((tick, index) => (
              <div
                className={classNames(
                  "motion-ruler-tick",
                  "dialkit-timeline-tick",
                  index > 0 && index === model.ticks.length - 1 && "last"
                )}
                key={tick}
                style={{ left: percentOf(tick) }}
              >
                <span className="dialkit-timeline-tick-label">
                  {formatTime(tick)}
                </span>
              </div>
            ))}
            <span
              className="motion-playhead-marker"
              aria-hidden="true"
              style={{ left: `${playheadPercent}%` }}
            >
              {/* Always centered on the playhead line; it overflows the ruler edges at 0% / 100%. */}
              <span className="motion-playhead-pill">
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
                className="motion-group-row dialkit-timeline-row dialkit-timeline-group-row"
                onClick={() => toggleGroup(group.id)}
              >
                <div className="motion-group-label dialkit-timeline-label">
                  {/* The row's click handler toggles; a keyboard activation of this button bubbles to it. */}
                  <button
                    className="motion-group-toggle dialkit-timeline-group-toggle"
                    type="button"
                    data-open={!collapsed}
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 9.5L12 15.5L18 9.5" />
                    </svg>
                  </button>
                  <span className="motion-group-name">{group.label}</span>
                </div>
                <div className="motion-group-lane dialkit-timeline-lane">
                  {gridLines}
                </div>
              </div>

              {collapsed
                ? null
                : group.rows.map((row) => {
                    const { animation, startMs } = row;
                    const rawDurationRange = getDurationRange?.(animation);
                    const durationRange = onResizeDuration
                      ? rawDurationRange
                      : undefined;
                    const startRange =
                      onMoveStart || onResizeStart
                        ? getStartRange?.(animation)
                        : undefined;
                    const movable = Boolean(startRange && onMoveStart);
                    const startResizable = Boolean(
                      startRange && rawDurationRange && onResizeStart
                    );
                    const resizing =
                      resize?.instanceId === animation.instanceId
                        ? resize
                        : undefined;
                    const editing =
                      edit?.instanceId === animation.instanceId
                        ? edit
                        : undefined;
                    const moving = editing?.mode === "move";
                    const baseEndMs =
                      animationDisplayEnd(animation) - model.originMs;
                    let barStartMs = startMs;
                    let endMs = baseEndMs;
                    let displayDuration = row.durationMs;
                    if (resizing) {
                      endMs = startMs + resizing.durationMs;
                      displayDuration = resizing.durationMs;
                    } else if (editing) {
                      const shiftMs = editing.delayMs - editing.baseDelayMs;
                      barStartMs = startMs + shiftMs;
                      if (editing.mode === "move") {
                        endMs = baseEndMs + shiftMs;
                      } else if (editing.durationMs !== undefined) {
                        endMs = barStartMs + editing.durationMs;
                        displayDuration = editing.durationMs;
                      }
                    }
                    const dragging = Boolean(resizing || editing);
                    const selected =
                      animation.instanceId === selectedAnimationId;

                    return (
                      <div
                        className={classNames(
                          "motion-row",
                          "dialkit-timeline-row",
                          selected && "selected",
                          dragging && "resizing"
                        )}
                        data-grouped=""
                        key={animation.instanceId}
                      >
                        <button
                          className="motion-row-label dialkit-timeline-label"
                          type="button"
                          aria-pressed={selected}
                          onClick={() => onSelectAnimation(animation.instanceId)}
                        >
                          <KindGlyph spring={animation.animationKind === "spring"} />
                          <span className="motion-row-name">{row.label}</span>
                          <span className="motion-row-kind">· {row.kindLabel}</span>
                          <span className="motion-row-duration">
                            {displayDuration !== undefined
                              ? `${row.estimated && !dragging ? "~" : ""}${formatTime(
                                  displayDuration
                                )}`
                              : "—"}
                          </span>
                        </button>
                        <div
                          className="motion-row-lane dialkit-timeline-lane"
                          {...scrubHandlers}
                        >
                          {gridLines}
                          <button
                            className={classNames(
                              "motion-bar",
                              "dialkit-timeline-clip",
                              row.estimated && !dragging && "estimated",
                              selected && "selected",
                              movable && "movable",
                              moving && "moving"
                            )}
                            data-selected={selected ? "" : undefined}
                            data-dragging={dragging ? "" : undefined}
                            type="button"
                            aria-label={`${row.label} · ${row.kindLabel}`}
                            style={{
                              left: percentOf(barStartMs),
                              width: `${Math.max(
                                0.8,
                                ((endMs - barStartMs) / model.durationMs) * 100
                              )}%`
                            }}
                            title={animationSpanTitle(
                              animation,
                              displayDuration,
                              row.estimated
                            )}
                            onPointerDown={(event) =>
                              startRange && onMoveStart
                                ? handleBarPointerDown(
                                    event,
                                    animation,
                                    startMs,
                                    startRange
                                  )
                                : event.stopPropagation()
                            }
                            onPointerMove={
                              movable ? handleBarPointerMove : undefined
                            }
                            onPointerUp={movable ? handleBarPointerUp : undefined}
                            onPointerCancel={
                              movable ? handleBarPointerCancel : undefined
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              if (suppressClickRef.current) {
                                suppressClickRef.current = false;
                                return;
                              }
                              onSelectAnimation(animation.instanceId);
                            }}
                          />
                          {startResizable && startRange && rawDurationRange ? (
                            <span
                              className={classNames(
                                "motion-bar-resize",
                                "start",
                                (selected || dragging) && "active"
                              )}
                              aria-hidden="true"
                              style={{
                                left: `calc(${percentOf(barStartMs)} - 4px)`
                              }}
                              onPointerDown={(event) =>
                                handleStartEdgePointerDown(
                                  event,
                                  animation,
                                  startMs,
                                  startRange,
                                  rawDurationRange,
                                  row.durationMs
                                )
                              }
                              onPointerMove={handleStartEdgePointerMove}
                              onPointerUp={handleStartEdgePointerUp}
                              onPointerCancel={handleStartEdgePointerCancel}
                              onClick={(event) => event.stopPropagation()}
                            />
                          ) : null}
                          {durationRange ? (
                            <span
                              className={classNames(
                                "motion-bar-resize",
                                (selected || dragging) && "active"
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
