import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";

export interface AnimationRow {
  animation: RuntimeAnimationTrace;
  /** Humanized property name, e.g. "Move X". */
  label: string;
  /** "Timing" | "Spring" */
  kindLabel: string;
  /** Relative to the model's originMs. */
  startMs: number;
  /** Observed (ended - started) when the animation has ended, else the expected duration. */
  durationMs: number | undefined;
  /** No observed end, and the expected duration is a spring estimate. */
  estimated: boolean;
}

export interface AnimationGroup {
  /** Element id: the target up to (not including) its last dot segment; the whole target when it has no dot. */
  id: string;
  label: string;
  rows: AnimationRow[];
}

export interface TimelineModel {
  groups: AnimationGroup[];
  originMs: number;
  durationMs: number;
  ticks: number[];
  /** Midpoints between consecutive ticks. */
  minorTicks: number[];
}

export interface TimingDurationControl {
  schemaId: string;
  controlId: string;
  min: number;
  max: number;
  step: number;
  /** Current control value in ms. */
  value: number;
}

export function buildTimelineModel(
  animations: RuntimeAnimationTrace[]
): TimelineModel {
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

  const minorTicks: number[] = [];
  for (let index = 1; index < ticks.length; index += 1) {
    minorTicks.push((ticks[index - 1]! + ticks[index]!) / 2);
  }

  return {
    groups: groupAnimationRows(animations, originMs),
    originMs,
    durationMs,
    ticks,
    minorTicks
  };
}

/** Groups in order of first appearance by start time; rows by start time, ties in original array order. */
function groupAnimationRows(
  animations: RuntimeAnimationTrace[],
  originMs: number
): AnimationGroup[] {
  const ordered = animations
    .map((animation, index) => ({ animation, index }))
    .sort(
      (left, right) =>
        left.animation.startedAtRuntimeMs - right.animation.startedAtRuntimeMs ||
        left.index - right.index
    );
  const groups = new Map<string, AnimationGroup>();

  for (const { animation } of ordered) {
    const id = animationElementId(animation.target);
    let group = groups.get(id);
    if (!group) {
      group = { id, label: id, rows: [] };
      groups.set(id, group);
    }

    const observedDurationMs =
      animation.endedAtRuntimeMs !== undefined
        ? Math.max(0, animation.endedAtRuntimeMs - animation.startedAtRuntimeMs)
        : undefined;

    group.rows.push({
      animation,
      label: animationTargetLabel(animation.target),
      kindLabel: animation.animationKind === "spring" ? "Spring" : "Timing",
      startMs: animation.startedAtRuntimeMs - originMs,
      durationMs: observedDurationMs ?? animation.expectedDurationMs,
      estimated:
        observedDurationMs === undefined &&
        animation.durationBasis === "spring-estimate"
    });
  }

  return Array.from(groups.values());
}

function animationElementId(target: string): string {
  const lastDot = target.lastIndexOf(".");
  return lastDot === -1 ? target : target.slice(0, lastDot);
}

export function activeAnimationAtTime(
  animations: RuntimeAnimationTrace[],
  originMs: number,
  timeMs: number
): RuntimeAnimationTrace | undefined {
  return [...animations]
    .filter((animation) => {
      const startMs = animation.startedAtRuntimeMs - originMs;
      const endMs = animationDisplayEnd(animation) - originMs;
      return timeMs >= startMs && timeMs <= endMs;
    })
    .sort(
      (left, right) => right.startedAtRuntimeMs - left.startedAtRuntimeMs
    )[0];
}

export function animationTargetLabel(target: string): string {
  const leaf = target.split(".").at(-1) ?? target;
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function animationDisplayEnd(animation: RuntimeAnimationTrace): number {
  if (animation.endedAtRuntimeMs !== undefined) {
    return animation.endedAtRuntimeMs;
  }
  if (animation.expectedDurationMs !== undefined) {
    return animation.startedAtRuntimeMs + animation.expectedDurationMs;
  }
  return animation.startedAtRuntimeMs + 16;
}

export function chooseTickStep(durationMs: number): number {
  if (durationMs <= 450) return 50;
  if (durationMs <= 800) return 100;
  if (durationMs <= 1600) return 200;
  if (durationMs <= 3500) return 500;
  if (durationMs <= 7000) return 1000;
  return 2000;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Resolves the slider control behind a timing span's duration, or undefined when the span is not tunable. */
export function timingDurationControl(
  animation: RuntimeAnimationTrace,
  schemas: readonly PanelSchema[],
  values: Readonly<Record<string, Record<string, unknown> | undefined>>
): TimingDurationControl | undefined {
  if (animation.animationKind !== "timing") return undefined;
  const ref = animation.parameterControls?.duration;
  if (!ref) return undefined;
  const schema = schemas.find((candidate) => candidate.id === ref.schemaId);
  if (!schema) return undefined;

  for (const group of schema.groups) {
    for (const control of group.controls) {
      if (control.id !== ref.controlId) continue;
      if (control.kind !== "slider") return undefined;
      const live = values[ref.schemaId]?.[ref.controlId];
      const value =
        typeof live === "number" && Number.isFinite(live)
          ? live
          : (control.value ?? control.defaultValue);
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      return {
        schemaId: ref.schemaId,
        controlId: ref.controlId,
        min: control.min,
        max: control.max,
        step: control.step ?? 1,
        value
      };
    }
  }
  return undefined;
}

/** Duration implied by dragging a span's right edge to `pointerMs` (timeline time). Snapped to `step`, bounded to [min, max]. */
export function resizedDurationMs(input: {
  startMs: number;
  pointerMs: number;
  min: number;
  max: number;
  step: number;
}): number {
  const step = input.step > 0 && Number.isFinite(input.step) ? input.step : 1;
  const raw = input.pointerMs - input.startMs;
  const snapped = Math.round(raw / step) * step;
  const bounded = clamp(snapped, input.min, input.max);
  return Number.isFinite(bounded) ? bounded : input.min;
}
