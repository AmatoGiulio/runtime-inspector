import type {
  RIPMessage,
  RuntimeAnimationMeta
} from "@runtime-inspector/protocol";
import { consumeAppliedStartDelay } from "./animation-start-state";
import { noteAnimationCallsiteStarted } from "./scenes";

type RuntimeAnimationEmitter = (
  schemaId: string | undefined,
  message: RIPMessage
) => void;

// `var`, not `let`: importing scenes.ts closes an import cycle through index.ts, which
// installs the emitter while this module may still be evaluating (a `let` would be in its TDZ).
// eslint-disable-next-line no-var
var emitRuntimeAnimation: RuntimeAnimationEmitter | undefined;
let instanceCounter = 0;

export function setRuntimeAnimationEmitter(emitter: RuntimeAnimationEmitter): void {
  emitRuntimeAnimation = emitter;
}

/**
 * Development-only observation seam injected by the Babel plugin.
 *
 * Crucially, this helper DOES NOT construct, clone, mutate, or inspect the
 * Reanimated animation object. The application's original `withTiming(...)`
 * / `withSpring(...)` call runs first in the application module; this helper
 * receives the result and returns the exact same object unchanged.
 *
 * That keeps the feasibility spike behavior-transparent: instrumentation may
 * fail, but it must never decide whether the app's own animation can run.
 */
export function __riObserveAnimation<T>(
  animation: T,
  meta: RuntimeAnimationMeta
): T {
  const calledAt = nowMs();
  try {
    const applied = consumeAppliedStartDelay(meta.callsiteId);
    reportAnimationStarted(
      meta,
      runtimeAnimationInstanceId(meta.callsiteId),
      calledAt + (applied ?? 0),
      applied
    );
  } catch {
    // Observation is strictly best-effort.
  }

  try {
    // RFC 0008 §3: lets an automatic scene know the app already ran its motion.
    noteAnimationCallsiteStarted(meta.callsiteId, calledAt);
  } catch {
    // Observation is strictly best-effort.
  }

  return animation;
}

export function reportAnimationStarted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  startedAtRuntimeMs: number,
  startDelayMs?: number
): void {
  emitRuntimeAnimation?.(meta.schemaId, {
    type: "animation.started",
    instanceId,
    callsiteId: meta.callsiteId,
    schemaId: meta.schemaId,
    target: meta.target,
    animationKind: meta.animationKind,
    startedAtRuntimeMs,
    toValue: meta.toValue,
    config: meta.config ?? {},
    configControlId: meta.configControlId,
    ...(meta.parameterControls !== undefined
      ? { parameterControls: meta.parameterControls }
      : {}),
    ...(meta.startControl !== undefined ? { startControl: meta.startControl } : {}),
    ...(startDelayMs !== undefined ? { startDelayMs } : {}),
    source: meta.source
  });
}

export function reportAnimationCompleted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  endedAtRuntimeMs: number,
  finished: boolean,
  current: string | number | boolean | null | undefined
): void {
  emitRuntimeAnimation?.(meta.schemaId, {
    type: "animation.completed",
    instanceId,
    callsiteId: meta.callsiteId,
    schemaId: meta.schemaId,
    target: meta.target,
    animationKind: meta.animationKind,
    endedAtRuntimeMs,
    finished,
    current
  });
}

function runtimeAnimationInstanceId(callsiteId: string): string {
  instanceCounter += 1;
  return `${callsiteId}:${nowMs()}:${instanceCounter}`;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}