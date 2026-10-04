import type { LiteralAnchor } from "@runtime-inspector/protocol";
import { recordAppliedStartDelay } from "./animation-start-state";
import { registerRuntimeValue } from "./auto";

declare const __DEV__: boolean | undefined;

/** One literal config parameter the Babel plugin backs with an `auto` schema control. */
export interface RuntimeAnimationConfigBinding {
  key: string;
  controlId: string;
  label: string;
  declared: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Literal anchor for write-back (RFC 0007), copied onto the control. */
  literal?: LiteralAnchor;
}

/** The slider a call site's delay is backed by (RFC 0005 §3c). */
export interface RuntimeAnimationStartBinding {
  callsiteId: string;
  controlId?: string;
  label?: string;
  declared?: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Literal anchor for write-back (RFC 0007), copied onto the control. */
  literal?: LiteralAnchor;
}

/** Binding for `__riAnimationStart`: the control is always present and declared is 0. */
export interface RuntimeAnimationStartWrapBinding {
  callsiteId: string;
  controlId: string;
  label: string;
  declared: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Literal anchor for write-back (RFC 0007), copied onto the control. */
  literal?: LiteralAnchor;
}

interface HolderBinding {
  controlId: string;
  label: string;
  declared: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Literal anchor for write-back (RFC 0007), copied onto the control. */
  literal?: LiteralAnchor;
}

interface ConfigControlEntry {
  holder: { value: number };
  declared: number;
  dispose: () => void;
}

/** controlId -> the live holder behind that call site's `auto` control. */
const entries = new Map<string, ConfigControlEntry>();
let warnedInternalFailure = false;

/**
 * Development-only seam injected by the Babel plugin around the config
 * argument of a discovered `withTiming(...)` call (RFC 0005 §3b). Each binding
 * registers, once per call site, a slider control in the `auto` Runtime Value
 * schema holding the declared source literal as its default.
 *
 * Identity guarantee: while every bound control still equals its declared
 * literal, this returns `config` itself - the same object, not a copy. The
 * instrumentation is therefore behavior-transparent until a developer
 * deliberately tunes a control; only then is a shallow copy carrying the tuned
 * value(s) returned. `config` is never mutated.
 *
 * No-op in production, and never throws into application code: any internal
 * failure returns the original `config` and warns once in development.
 */
export function __riAnimationConfig<T>(
  config: T,
  bindings: readonly RuntimeAnimationConfigBinding[]
): T {
  if (!isDev()) {
    return config;
  }

  try {
    const overrides: Record<string, number> = {};

    for (const binding of bindings) {
      if (typeof binding.declared !== "number" || !Number.isFinite(binding.declared)) continue;

      const holder = ensureHolder(binding);
      const value = holder.value;
      if (typeof value === "number" && Number.isFinite(value) && value !== binding.declared) {
        overrides[binding.key] = value;
      }
    }

    if (typeof config !== "object" || config === null) return config;
    if (Object.keys(overrides).length === 0) return config;

    return { ...config, ...overrides };
  } catch (error) {
    warnInternalFailureOnce("__riAnimationConfig", "animation config", error);
    return config;
  }
}

function ensureHolder(binding: HolderBinding): { value: number } {
  const existing = entries.get(binding.controlId);
  if (existing) {
    if (existing.declared === binding.declared) {
      return existing.holder;
    }
    // The source literal changed (Fast Refresh): drop the stale tuned value and
    // re-register with the new default.
    entries.delete(binding.controlId);
    existing.dispose();
  }

  const holder = { value: binding.declared };
  const dispose = registerRuntimeValue(
    {
      kind: "value",
      name: binding.controlId,
      sharedValue: holder,
      meta: {
        min: binding.min,
        max: binding.max,
        step: binding.step,
        unit: binding.unit,
        label: binding.label,
        ...(binding.literal !== undefined ? { literal: binding.literal } : {})
      },
      target: binding.declared
    },
    "replace"
  );
  entries.set(binding.controlId, { holder, declared: binding.declared, dispose });
  return holder;
}

/**
 * Development-only seam injected by the Babel plugin around the delay argument of
 * a discovered `withDelay(<delay>, <animation>)` (RFC 0005 §3c). With a literal
 * delay the binding carries a control: the declared literal is returned until a
 * developer tunes the control, then the tuned value. Otherwise the delay is
 * returned untouched and only the applied delay is recorded for observation.
 *
 * No-op in production, and never throws into application code.
 */
export function __riAnimationDelay<T>(delay: T, binding: RuntimeAnimationStartBinding): T | number {
  if (!isDev()) {
    return delay;
  }

  try {
    let result: T | number = delay;

    if (
      typeof binding.controlId === "string" &&
      typeof binding.declared === "number" &&
      Number.isFinite(binding.declared)
    ) {
      const holder = ensureHolder({
        controlId: binding.controlId,
        label: binding.label ?? binding.controlId,
        declared: binding.declared,
        min: binding.min ?? 0,
        max: binding.max ?? 10000,
        step: binding.step,
        unit: binding.unit,
        literal: binding.literal
      });
      const value = holder.value;
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value !== binding.declared) {
        result = value;
      }
    }

    recordAppliedStartDelay(
      binding.callsiteId,
      typeof result === "number" && Number.isFinite(result) && result >= 0 ? result : 0
    );
    return result;
  } catch (error) {
    warnInternalFailureOnce("__riAnimationDelay", "delay", error);
    return delay;
  }
}

/**
 * Development-only seam injected by the Babel plugin around a bare
 * `withTiming(...)` / `withSpring(...)` call in a module that imports Reanimated
 * (RFC 0005 §3c). Registers a delay control declared at 0. While it is 0 the
 * very same `animation` object is returned; once tuned above 0 the animation is
 * delayed through the `withDelay` the instrumented module passed in, so this
 * package never imports Reanimated.
 *
 * No-op in production, and never throws into application code.
 */
export function __riAnimationStart<T>(
  animation: T,
  binding: RuntimeAnimationStartWrapBinding,
  withDelay: unknown
): T {
  if (!isDev()) {
    return animation;
  }

  try {
    const holder = ensureHolder(binding);
    const value = holder.value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && typeof withDelay === "function") {
      recordAppliedStartDelay(binding.callsiteId, value);
      return withDelay(value, animation) as T;
    }

    recordAppliedStartDelay(binding.callsiteId, 0);
    return animation;
  } catch (error) {
    warnInternalFailureOnce("__riAnimationStart", "animation", error);
    return animation;
  }
}

/** Test-only: clears module-level state between test runs. */
export function __resetAnimationConfigForTests(): void {
  entries.clear();
  warnedInternalFailure = false;
}

function warnInternalFailureOnce(helper: string, subject: string, error: unknown): void {
  if (warnedInternalFailure) return;
  warnedInternalFailure = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[Runtime Inspector] ${helper} failed and returned the original ${subject}: ${reason}`
  );
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
