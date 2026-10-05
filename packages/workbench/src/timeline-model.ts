import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type {
  InspectorControl,
  PanelSchema,
  SourceApplyErrorCode,
  SourceApplyResultEntry
} from "@runtime-inspector/protocol";

export interface AnimationRow {
  animation: RuntimeAnimationTrace;
  /**
   * Stable React key across replays: the call site id, suffixed `#2`, `#3`... (input order) when
   * the same call site ran more than once in the burst. Instance ids change on every replay.
   */
  key: string;
  /** Humanized property name, e.g. "Move X". */
  label: string;
  /** "Timing" | "Spring" */
  kindLabel: string;
  /** Relative to the model's originMs. */
  startMs: number;
  /** Delay already included in `startMs` (`animation.startDelayMs ?? 0`); the call happened at `startMs - delayMs`. */
  delayMs: number;
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

export interface TimelineModelOptions {
  /** The ruler never shows less than this (rounded up to its tick step); keeps the scale from shrinking. */
  minDurationMs?: number;
}

export function buildTimelineModel(
  animations: RuntimeAnimationTrace[],
  options: TimelineModelOptions = {}
): TimelineModel {
  const originMs = timelineOriginMs(animations);
  const maxEndMs = Math.max(
    ...animations.map((animation) => animationDisplayEnd(animation))
  );
  const contentDurationMs = Math.max(1, maxEndMs - originMs);
  const rawDuration = Math.max(contentDurationMs, options.minDurationMs ?? 0);
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

interface OrderedAnimation {
  animation: RuntimeAnimationTrace;
  /** Position in the input array. */
  index: number;
}

function orderedEntries(animations: RuntimeAnimationTrace[]): OrderedAnimation[] {
  const entries = animations.map((animation, index) => ({ animation, index }));
  if (!animations.every((animation) => animation.source)) return entries;

  return entries.sort((left, right) => {
    const a = left.animation.source!;
    const b = right.animation.source!;
    return (
      compareText(a.file, b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      left.index - right.index
    );
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The display order of a burst, independent of timing so that moving a block never reshuffles
 * the hierarchy. `animation.started` is emitted at call time, so the input order is already the
 * order the app's code runs; when every animation carries a source location the order is made
 * explicit: (file, line, column), input order breaking ties. Otherwise the input order is kept.
 */
export function orderAnimations(
  animations: RuntimeAnimationTrace[]
): RuntimeAnimationTrace[] {
  return orderedEntries(animations).map((entry) => entry.animation);
}

/**
 * The stable per-row key of each animation, in input order: its call site id, suffixed `#2`, `#3`...
 * for repeats of the same call site. Instance ids change on every replay; this does not.
 */
export function animationKeys(animations: RuntimeAnimationTrace[]): string[] {
  const seen = new Map<string, number>();
  return animations.map((animation) => {
    const count = (seen.get(animation.callsiteId) ?? 0) + 1;
    seen.set(animation.callsiteId, count);
    return count === 1 ? animation.callsiteId : `${animation.callsiteId}#${count}`;
  });
}

/**
 * The burst to show while a replay's events arrive one at a time: every `incoming` animation, plus
 * each `displayed` animation whose key has not (yet) come back, rebased into the incoming time base
 * so it stays where it was on screen. Rows keep the displayed order, so the hierarchy does not move
 * and no row unmounts. Never mutates; kept animations are shallow copies.
 */
export function mergeBurst(
  displayed: RuntimeAnimationTrace[],
  incoming: RuntimeAnimationTrace[]
): RuntimeAnimationTrace[] {
  if (incoming.length === 0) return displayed;
  if (displayed.length === 0) return incoming;

  const incomingKeys = animationKeys(incoming);
  const incomingByKey = new Map<string, RuntimeAnimationTrace>();
  incoming.forEach((animation, index) =>
    incomingByKey.set(incomingKeys[index]!, animation)
  );
  const incomingIds = new Set(incoming.map((animation) => animation.instanceId));
  const shiftMs = timelineOriginMs(incoming) - timelineOriginMs(displayed);
  const displayedKeys = animationKeys(displayed);
  const used = new Set<RuntimeAnimationTrace>();
  const merged: RuntimeAnimationTrace[] = [];

  displayed.forEach((animation, index) => {
    const replacement = incomingByKey.get(displayedKeys[index]!);
    if (replacement) {
      used.add(replacement);
      merged.push(replacement);
    } else if (incomingIds.has(animation.instanceId)) {
      // Same instance, different key: the incoming copy is added below, unchanged.
    } else {
      merged.push({
        ...animation,
        startedAtRuntimeMs: animation.startedAtRuntimeMs + shiftMs,
        ...(animation.endedAtRuntimeMs !== undefined
          ? { endedAtRuntimeMs: animation.endedAtRuntimeMs + shiftMs }
          : {})
      });
    }
  });

  for (const animation of incoming) {
    if (!used.has(animation)) merged.push(animation);
  }

  return merged;
}

/** Identity of the set of animations on screen: the sorted, joined call site ids. */
export function timelineSignature(animations: RuntimeAnimationTrace[]): string {
  return animations
    .map((animation) => animation.callsiteId)
    .sort(compareText)
    .join("|");
}

/**
 * Sticky ruler length: while the same set of animations is on screen it only grows, so lengthening
 * or moving one block does not rescale the others. A different set resets to its content duration.
 */
export function nextStickyDuration(
  previous: { signature: string; durationMs: number } | undefined,
  signature: string,
  contentDurationMs: number
): { signature: string; durationMs: number } {
  if (previous && previous.signature === signature) {
    return {
      signature,
      durationMs: Math.max(previous.durationMs, contentDurationMs)
    };
  }
  return { signature, durationMs: contentDurationMs };
}

/** How long a released edit stays on screen waiting for the runtime's replay before it is dropped. */
export const PENDING_PREVIEW_TTL_MS = 2000;

/**
 * A released drag/resize shown optimistically until the runtime confirms it. Keyed by the row's
 * stable `key` (call site); `instanceId` is the instance it was made on.
 */
export interface PendingPreview {
  key: string;
  instanceId: string;
  /** `performance.now()` at release. */
  createdAtMs: number;
  mode: "move" | "resize-start" | "resize-end";
  /** Change of the start delay (bar start shift) in ms; 0 for an end resize. */
  shiftMs: number;
  /** Previewed duration for the resizes. */
  durationMs?: number;
}

/**
 * Whether a pending preview still applies to `row`: dropped when the row's instance differs (the
 * replay arrived), when it belongs to another row, or after `ttlMs` without a new instance.
 */
export function resolvePendingPreview(
  pending: PendingPreview | undefined,
  row: { key: string; instanceId: string },
  nowMs: number,
  ttlMs: number = PENDING_PREVIEW_TTL_MS
): PendingPreview | undefined {
  if (!pending) return undefined;
  if (pending.key !== row.key) return undefined;
  if (pending.instanceId !== row.instanceId) return undefined;
  if (nowMs - pending.createdAtMs >= ttlMs) return undefined;
  return pending;
}

/** Groups in order of the first row of each under `orderAnimations`; rows keep that order. */
function groupAnimationRows(
  animations: RuntimeAnimationTrace[],
  originMs: number
): AnimationGroup[] {
  // Keys are numbered in input order, so a repeated call site keeps its suffix whatever the sort.
  const keys = animationKeys(animations);
  const groups = new Map<string, AnimationGroup>();

  for (const { animation, index } of orderedEntries(animations)) {
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
      key: keys[index]!,
      label,
      kindLabel: animation.animationKind === "spring" ? "Spring" : "Timing",
      startMs: animation.startedAtRuntimeMs - originMs,
      delayMs: animation.startDelayMs ?? 0,
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
 * The animations called at or after `callTimeMs` (1 ms tolerance), in input order. Used to keep a
 * scene's timeline to the motion that followed its `playing` time (RFC 0006 §5).
 */
export function animationsSince(
  animations: RuntimeAnimationTrace[],
  callTimeMs: number
): RuntimeAnimationTrace[] {
  return animations.filter(
    (animation) => animationCallTimeMs(animation) >= callTimeMs - 1
  );
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

/**
 * RFC 0007: the controls among `entries` that the session lists as pending
 * literal changes, grouped by schema for `session.applySource`. The session's
 * list is the single source of truth, so the Inspector and the timeline
 * toolbar agree (stale schemas and changes already written are left out there).
 */
export function literalApplyGroups(
  entries: ReadonlyArray<{ schemaId: string; control: InspectorControl }>,
  pending: ReadonlyArray<{ schemaId: string; controlId: string }>
): Array<{ schemaId: string; controlIds: string[] }> {
  const pendingKeys = new Set(pending.map((change) => `${change.schemaId}\u0000${change.controlId}`));
  return groupControlIdsBySchema(
    entries
      .filter((entry) => pendingKeys.has(`${entry.schemaId}\u0000${entry.control.id}`))
      .map((entry) => ({ schemaId: entry.schemaId, controlId: entry.control.id }))
  );
}

/** Control ids grouped by schema, in first-seen order. */
export function groupControlIdsBySchema(
  items: ReadonlyArray<{ schemaId: string; controlId: string }>
): Array<{ schemaId: string; controlIds: string[] }> {
  const groups = new Map<string, string[]>();
  for (const { schemaId, controlId } of items) {
    const ids = groups.get(schemaId) ?? [];
    if (!ids.includes(controlId)) ids.push(controlId);
    groups.set(schemaId, ids);
  }
  return Array.from(groups, ([schemaId, controlIds]) => ({ schemaId, controlIds }));
}

const APPLY_FAILURE_TEXT: Record<SourceApplyErrorCode, string> = {
  PARSE_FAILURE: "The file no longer parses — fix it and try again",
  DECLARATION_MISSING: "The code was not found in the file",
  DECLARATION_MOVED: "The code moved in the file — reload the app and try again",
  DECLARATION_AMBIGUOUS: "The code appears more than once in the file",
  EXPRESSION_MISMATCH: "The file changed since the app was built — reload the app and try again",
  WRITE_FAILURE: "The file could not be written"
};

/** The notice shown after a `source.applyResult`. */
export function applyResultNotice(results: readonly SourceApplyResultEntry[]): string {
  const applied = results.filter((result) => result.ok).length;
  const failure = results.find(
    (result): result is Extract<SourceApplyResultEntry, { ok: false }> => !result.ok
  );
  if (!failure) {
    return `Applied ${applied} ${applied === 1 ? "change" : "changes"} to code`;
  }
  const reason = APPLY_FAILURE_TEXT[failure.code] ?? "The change could not be applied";
  return applied > 0 ? `Applied ${applied} of ${results.length} changes. ${reason}` : reason;
}

/**
 * The scene Play and timeline edits replay: the selected scene when the app can show it (it is on
 * screen or reachable), else the scene on screen, else the selected scene unchanged so a stale or
 * cold-start selection still reaches the deep-link path.
 */
export function playbackTargetScene<
  T extends { id: string; active?: boolean; reachable?: boolean }
>(scenes: readonly T[], selectedId: string | undefined): T | undefined {
  const selected =
    selectedId === undefined ? undefined : scenes.find((scene) => scene.id === selectedId);
  if (selected && (selected.active || selected.reachable)) return selected;
  return scenes.find((scene) => scene.active) ?? selected;
}
