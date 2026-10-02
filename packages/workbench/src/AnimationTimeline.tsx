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
  resizedFromStart,
  resolvePendingPreview,
  PENDING_PREVIEW_TTL_MS,
  type PendingPreview
} from "./timeline-model";

/** Pointer travel below this many pixels is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

export interface AnimationTimelineProps {
  animations: RuntimeAnimationTrace[];
  selectedAnimationId?: string;
  /** Lower bound of the ruler length; lets the parent keep the scale from shrinking between replays. */
  minDurationMs?: number;
  /** Fired by a double-click on the ruler: reset the scale to fit the current content. */
  onRefitScale?(): void;
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

/** Stable row key (call site) the session was started on; a pending preview is stored under it. */
interface SessionRow {
  rowKey: string;
}

interface ResizeSession extends ResizeState, SessionRow {
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

interface EditSession extends EditState, SessionRow {
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
  minDurationMs,
  onRefitScale,
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
  const model = useMemo(
    () => buildTimelineModel(animations, { minDurationMs }),
    [animations, minDurationMs]
  );
  const dragRef = useRef(false);
  const resizeRef = useRef<ResizeSession | undefined>(undefined);
  const [resize, setResize] = useState<ResizeState | undefined>(undefined);
  const editRef = useRef<EditSession | undefined>(undefined);
  const [edit, setEdit] = useState<EditState | undefined>(undefined);
  /** Set when a move drag ended: the click the browser fires after it must not select again. */
  const suppressClickRef = useRef(false);
  /** Released edits shown at their new position until the runtime's replay confirms them (by row key). */
  const [pendingPreviews, setPendingPreviews] = useState<
    ReadonlyMap<string, PendingPreview>
  >(() => new Map());
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

  // A replay gives every animation a new instance id: a preview or session keyed by an id that
  // is gone would stay stuck, so drop it.
  useEffect(() => {
    const ids = new Set(animations.map((animation) => animation.instanceId));
    if (resizeRef.current && !ids.has(resizeRef.current.instanceId)) {
      resizeRef.current = undefined;
    }
    if (editRef.current && !ids.has(editRef.current.instanceId)) {
      editRef.current = undefined;
    }
    setResize((current) =>
      current && !ids.has(current.instanceId) ? undefined : current
    );
    setEdit((current) =>
      current && !ids.has(current.instanceId) ? undefined : current
    );
  }, [animations]);

  // Drop pending previews whose row is gone or has a new instance (the replay arrived). Rendering
  // already ignores them in that same pass; this releases the state.
  useEffect(() => {
    setPendingPreviews((current) => {
      if (current.size === 0) return current;
      const instanceByKey = new Map<string, string>();
      for (const group of model.groups) {
        for (const row of group.rows) {
          instanceByKey.set(row.key, row.animation.instanceId);
        }
      }
      const now = performance.now();
      const next = new Map<string, PendingPreview>();
      for (const [key, pending] of current) {
        const instanceId = instanceByKey.get(key);
        if (
          instanceId !== undefined &&
          resolvePendingPreview(pending, { key, instanceId }, now)
        ) {
          next.set(key, pending);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [model]);

  // A released edit the runtime never confirmed goes back to the truth after the time-to-live.
  useEffect(() => {
    if (pendingPreviews.size === 0) return;
    const now = performance.now();
    const earliest = Math.min(
      ...Array.from(pendingPreviews.values(), (pending) => pending.createdAtMs)
    );
    const timer = setTimeout(
      () => {
        const at = performance.now();
        setPendingPreviews((current) => {
          const next = new Map<string, PendingPreview>();
          for (const [key, pending] of current) {
            if (resolvePendingPreview(pending, pending, at)) {
              next.set(key, pending);
            }
          }
          return next.size === current.size ? current : next;
        });
      },
      Math.max(0, earliest + PENDING_PREVIEW_TTL_MS - now) + 1
    );
    return () => clearTimeout(timer);
  }, [pendingPreviews]);

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
    rowKey: string,
    startMs: number,
    currentDurationMs: number | undefined,
    range: { min: number; max: number; step: number }
  ) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dropPendingPreview(rowKey);
    onSelectAnimation(animation.instanceId);
    const initial = currentDurationMs ?? range.min;
    resizeRef.current = {
      rowKey,
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
      storePendingPreview(session, {
        mode: "resize-end",
        shiftMs: 0,
        durationMs: session.durationMs
      });
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

  function dropPendingPreview(rowKey: string) {
    setPendingPreviews((current) => {
      if (!current.has(rowKey)) return current;
      const next = new Map(current);
      next.delete(rowKey);
      return next;
    });
  }

  function storePendingPreview(
    session: SessionRow & { instanceId: string },
    preview: Pick<PendingPreview, "mode" | "shiftMs" | "durationMs">
  ) {
    const pending: PendingPreview = {
      key: session.rowKey,
      instanceId: session.instanceId,
      createdAtMs: performance.now(),
      ...preview
    };
    setPendingPreviews((current) => new Map(current).set(pending.key, pending));
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
    rowKey: string,
    startMs: number,
    startRange: { min: number; max: number; step: number; value: number }
  ) {
    event.stopPropagation();
    suppressClickRef.current = false;
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dropPendingPreview(rowKey);
    editRef.current = {
      rowKey,
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
      storePendingPreview(session, {
        mode: "move",
        shiftMs: session.delayMs - session.baseDelayMs
      });
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
    rowKey: string,
    startMs: number,
    startRange: { min: number; max: number; step: number; value: number },
    durationRange: { min: number; max: number; step: number },
    currentDurationMs: number | undefined
  ) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dropPendingPreview(rowKey);
    const baseDurationMs = currentDurationMs ?? durationRange.min;
    editRef.current = {
      rowKey,
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
      storePendingPreview(session, {
        mode: "resize-start",
        shiftMs: session.delayMs - session.baseDelayMs,
        durationMs: session.durationMs
      });
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
          <div
            className="motion-ruler dialkit-timeline-ruler"
            onDoubleClick={onRefitScale}
            {...scrubHandlers}
          >
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
                    className="wb-button toggle motion-group-toggle"
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
                    // The released edit stays put until the replay confirms it (not "dragging").
                    const pending = resolvePendingPreview(
                      pendingPreviews.get(row.key),
                      { key: row.key, instanceId: animation.instanceId },
                      performance.now()
                    );
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
                    } else if (pending) {
                      if (pending.mode === "resize-end") {
                        if (pending.durationMs !== undefined) {
                          endMs = startMs + pending.durationMs;
                          displayDuration = pending.durationMs;
                        }
                      } else {
                        barStartMs = startMs + pending.shiftMs;
                        if (pending.mode === "move") {
                          endMs = baseEndMs + pending.shiftMs;
                        } else if (pending.durationMs !== undefined) {
                          endMs = barStartMs + pending.durationMs;
                          displayDuration = pending.durationMs;
                        }
                      }
                    }
                    const dragging = Boolean(resizing || editing);
                    const previewing = dragging || Boolean(pending);
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
                        key={row.key}
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
                              ? `${row.estimated && !previewing ? "~" : ""}${formatTime(
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
                          {row.delayMs > 0 ? (
                            // The call time is fixed; the lead-in follows the previewed bar start.
                            <span
                              className="motion-lead-in"
                              aria-hidden="true"
                              style={{
                                left: percentOf(startMs - row.delayMs),
                                width: `${(Math.max(0, barStartMs - (startMs - row.delayMs)) / model.durationMs) * 100}%`
                              }}
                            />
                          ) : null}
                          <button
                            className={classNames(
                              "motion-bar",
                              "dialkit-timeline-clip",
                              animation.animationKind === "spring" && "spring",
                              row.estimated && !previewing && "estimated",
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
                                    row.key,
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
                                  row.key,
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
                                  row.key,
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
