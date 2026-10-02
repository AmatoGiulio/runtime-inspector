import type {
  RIPMessage,
  RuntimeAnimationMeta
} from "@runtime-inspector/protocol";

type RuntimeAnimationEmitter = (
  schemaId: string | undefined,
  message: RIPMessage
) => void;

let emitRuntimeAnimation: RuntimeAnimationEmitter | undefined;
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
  try {
    reportAnimationStarted(
      meta,
      runtimeAnimationInstanceId(meta.callsiteId),
      nowMs()
    );
  } catch {
    // Observation is strictly best-effort.
  }

  return animation;
}

export function reportAnimationStarted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  startedAtRuntimeMs: number
): void {
  emitRuntimeAnimation?.(meta.schemaId, {
    type: "animation.started",
    instanceId,
    callsiteId: meta.callsiteId,
    schemaId: meta.schemaId,
    target: meta.target,
    animationKind: meta.animationKind,
    startedAtRuntimeMs,
    config: {},
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
