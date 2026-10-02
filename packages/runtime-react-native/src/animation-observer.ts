import {
  runOnJS,
  withSpring,
  withTiming
} from "react-native-reanimated";
import type {
  RIPMessage,
  RuntimeAnimationConfig,
  RuntimeAnimationMeta
} from "@runtime-inspector/protocol";

type RuntimeAnimationEmitter = (
  schemaId: string | undefined,
  message: RIPMessage
) => void;

let emitRuntimeAnimation: RuntimeAnimationEmitter | undefined;

export function setRuntimeAnimationEmitter(emitter: RuntimeAnimationEmitter): void {
  emitRuntimeAnimation = emitter;
}

export function __riWithTiming<T>(
  toValue: T,
  config: Record<string, unknown> | undefined,
  meta: RuntimeAnimationMeta
): T {
  "worklet";

  const startedAtRuntimeMs = Date.now();
  const instanceId = runtimeAnimationInstanceId(meta.callsiteId, startedAtRuntimeMs);
  emitStarted(meta, instanceId, startedAtRuntimeMs, toValue, timingConfig(config));

  // Do not inject a completion callback here. This package is built by tsup,
  // not the Reanimated Babel plugin, so a callback authored here would not be
  // workletized and can prevent the animation from running on the UI runtime.
  // The feasibility spike intentionally observes start + static parameters
  // without changing the original animation execution semantics.
  return withTiming(toValue as never, config as never) as T;
}

export function __riWithSpring<T>(
  toValue: T,
  config: Record<string, unknown> | undefined,
  meta: RuntimeAnimationMeta
): T {
  "worklet";

  const startedAtRuntimeMs = Date.now();
  const instanceId = runtimeAnimationInstanceId(meta.callsiteId, startedAtRuntimeMs);
  emitStarted(meta, instanceId, startedAtRuntimeMs, toValue, springConfig(config));

  // Same rule as timing above: preserve Reanimated's original execution path.
  return withSpring(toValue as never, config as never) as T;
}

function emitStarted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  startedAtRuntimeMs: number,
  toValue: unknown,
  config: RuntimeAnimationConfig
): void {
  "worklet";
  const value = serializableValue(toValue);

  if (isWorkletRuntime()) {
    runOnJS(reportAnimationStarted)(
      meta,
      instanceId,
      startedAtRuntimeMs,
      value,
      config
    );
    return;
  }

  reportAnimationStarted(meta, instanceId, startedAtRuntimeMs, value, config);
}

function emitCompleted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  endedAtRuntimeMs: number,
  finished: boolean,
  current: string | number | boolean | null | undefined
): void {
  "worklet";

  if (isWorkletRuntime()) {
    runOnJS(reportAnimationCompleted)(
      meta,
      instanceId,
      endedAtRuntimeMs,
      finished,
      current
    );
    return;
  }

  reportAnimationCompleted(meta, instanceId, endedAtRuntimeMs, finished, current);
}

export function reportAnimationStarted(
  meta: RuntimeAnimationMeta,
  instanceId: string,
  startedAtRuntimeMs: number,
  toValue: string | number | boolean | null | undefined,
  config: RuntimeAnimationConfig
): void {
  emitRuntimeAnimation?.(meta.schemaId, {
    type: "animation.started",
    instanceId,
    callsiteId: meta.callsiteId,
    schemaId: meta.schemaId,
    target: meta.target,
    animationKind: meta.animationKind,
    startedAtRuntimeMs,
    toValue,
    config,
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

function runtimeAnimationInstanceId(callsiteId: string, startedAtRuntimeMs: number): string {
  "worklet";
  return `${callsiteId}:${startedAtRuntimeMs}:${Math.random().toString(36).slice(2, 8)}`;
}

function isWorkletRuntime(): boolean {
  "worklet";
  return Boolean((globalThis as { _WORKLET?: boolean })._WORKLET);
}

function serializableValue(
  value: unknown
): string | number | boolean | null | undefined {
  "worklet";
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return undefined;
}

function timingConfig(config: Record<string, unknown> | undefined): RuntimeAnimationConfig {
  "worklet";
  return compactConfig(config, ["duration"]);
}

function springConfig(config: Record<string, unknown> | undefined): RuntimeAnimationConfig {
  "worklet";
  return compactConfig(config, [
    "damping",
    "stiffness",
    "mass",
    "duration",
    "dampingRatio",
    "velocity",
    "overshootClamping",
    "energyThreshold"
  ]);
}

function compactConfig(
  config: Record<string, unknown> | undefined,
  keys: string[]
): RuntimeAnimationConfig {
  "worklet";
  const result: RuntimeAnimationConfig = {};
  if (!config) return result;

  for (const key of keys) {
    const value = config[key];
    if (
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }

  return result;
}