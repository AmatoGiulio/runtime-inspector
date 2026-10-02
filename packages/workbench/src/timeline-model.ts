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

/** A slider control resolved from a schema reference, with its current value. */
export interface AnimationControl {
  schemaId: string;
  controlId: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
}

export type TimingDurationControl = AnimationControl;

export interface ControlRef {
  schemaId: string;
  controlId: string;
}

type ControlValues = Readonly<Record<string, Record<string, unknown> | undefined>>;

export function buildTimelineModel(
  animations: RuntimeAnimationTrace[]
): TimelineModel {
  const originMs = timelineOriginMs(animations);
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
    const { group: id, label } = splitAnimationTarget(animation.target);
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
      label,
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

/**
 * Splits a target into its element group and a property label.
 * "card.moveX" -> card / "Move X"; "titleY" -> title / "Y"; "progress" -> progress / "Progress".
 */
export function splitAnimationTarget(target: string): {
  group: string;
  label: string;
} {
  const lastDot = target.lastIndexOf(".");
  if (lastDot !== -1) {
    return {
      group: target.slice(0, lastDot),
      label: humanizeName(target.slice(lastDot + 1))
    };
  }

  const boundary = /[a-z0-9](?=[A-Z])/.exec(target);
  if (boundary) {
    const split = boundary.index + 1;
    return {
      group: target.slice(0, split),
      label: humanizeName(target.slice(split))
    };
  }

  return { group: target, label: humanizeName(target) };
}

function humanizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

/** Time the animation's call happened: its start minus any delay already included in it. */
export function animationCallTimeMs(animation: RuntimeAnimationTrace): number {
  return animation.startedAtRuntimeMs - (animation.startDelayMs ?? 0);
}

/** Earliest call time of the animations; 0 for an empty list. */
export function timelineOriginMs(animations: RuntimeAnimationTrace[]): number {
  if (animations.length === 0) return 0;
  return Math.min(...animations.map(animationCallTimeMs));
}

/**
 * The animations of the last interaction: clusters by call time, a gap larger than
 * `idleGapMs` between consecutive calls starts a new cluster. Original relative order is kept.
 */
export function latestAnimationBurst(
  animations: RuntimeAnimationTrace[],
  idleGapMs = 450
): RuntimeAnimationTrace[] {
  if (animations.length === 0) return [];

  const callTimes = animations.map(animationCallTimeMs).sort((a, b) => a - b);
  let burstStartMs = callTimes[0]!;
  for (let index = 1; index < callTimes.length; index += 1) {
    if (callTimes[index]! - callTimes[index - 1]! > idleGapMs) {
      burstStartMs = callTimes[index]!;
    }
  }

  return animations.filter(
    (animation) => animationCallTimeMs(animation) >= burstStartMs
  );
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

/** Resolves a slider control reference against schema state; undefined when it is missing, not a slider or has no finite value. */
export function resolveSliderControl(
  ref: ControlRef | undefined,
  schemas: readonly PanelSchema[],
  values: ControlValues
): AnimationControl | undefined {
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
        value,
        ...(control.unit !== undefined ? { unit: control.unit } : {})
      };
    }
  }
  return undefined;
}

/** The control holding config parameter `key` (e.g. "duration", "damping") of an animation. */
export function parameterControl(
  animation: RuntimeAnimationTrace,
  key: string,
  schemas: readonly PanelSchema[],
  values: ControlValues
): AnimationControl | undefined {
  return resolveSliderControl(animation.parameterControls?.[key], schemas, values);
}

/** The control holding the delay applied before the animation starts. */
export function startControl(
  animation: RuntimeAnimationTrace,
  schemas: readonly PanelSchema[],
  values: ControlValues
): AnimationControl | undefined {
  return resolveSliderControl(animation.startControl, schemas, values);
}

/** Resolves the slider control behind a timing span's duration, or undefined when the span is not tunable. */
export function timingDurationControl(
  animation: RuntimeAnimationTrace,
  schemas: readonly PanelSchema[],
  values: ControlValues
): TimingDurationControl | undefined {
  if (animation.animationKind !== "timing") return undefined;
  return parameterControl(animation, "duration", schemas, values);
}

interface SliderRange {
  min: number;
  max: number;
  step: number;
}

function snapToRange(value: number, range: SliderRange): number {
  const step = range.step > 0 && Number.isFinite(range.step) ? range.step : 1;
  const snapped = Number((Math.round(value / step) * step).toPrecision(12));
  const bounded = clamp(snapped, range.min, range.max);
  return Number.isFinite(bounded) ? bounded : range.min;
}

/** Duration implied by dragging a span's right edge to `pointerMs` (timeline time). Snapped to `step`, bounded to [min, max]. */
export function resizedDurationMs(input: {
  startMs: number;
  pointerMs: number;
  min: number;
  max: number;
  step: number;
}): number {
  return snapToRange(input.pointerMs - input.startMs, input);
}

/** Delay implied by moving a span by `deltaMs`. Snapped to `step`, bounded to [min, max]. */
export function movedStartDelay(input: {
  delay: number;
  deltaMs: number;
  min: number;
  max: number;
  step: number;
}): number {
  return snapToRange(input.delay + input.deltaMs, input);
}

/**
 * Dragging a span's left edge by `deltaMs` keeps its end fixed: the delay moves and the duration
 * absorbs the delta. When a duration bound clips, the delay is re-derived to keep the end whenever
 * the delay range allows it.
 */
export function resizedFromStart(input: {
  delay: number;
  duration: number;
  deltaMs: number;
  delayRange: SliderRange;
  durationRange: SliderRange;
}): { delay: number; duration: number } {
  const { delayRange, durationRange } = input;
  const endMs = input.delay + input.duration;
  const delay = snapToRange(input.delay + input.deltaMs, delayRange);
  const appliedDelta = delay - input.delay;
  const unclipped = input.duration - appliedDelta;
  const duration = snapToRange(unclipped, durationRange);

  if (duration !== unclipped) {
    const keepEnd = endMs - duration;
    if (keepEnd >= delayRange.min && keepEnd <= delayRange.max) {
      return { delay: snapToRange(keepEnd, delayRange), duration };
    }
  }

  return { delay, duration };
}
