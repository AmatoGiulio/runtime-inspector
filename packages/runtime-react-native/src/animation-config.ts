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
    warnInternalFailureOnce(error);
    return config;
  }
}

function ensureHolder(binding: RuntimeAnimationConfigBinding): { value: number } {
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
        label: binding.label
      },
      target: binding.declared
    },
    "replace"
  );
  entries.set(binding.controlId, { holder, declared: binding.declared, dispose });
  return holder;
}

/** Test-only: clears module-level state between test runs. */
export function __resetAnimationConfigForTests(): void {
  entries.clear();
  warnedInternalFailure = false;
}

function warnInternalFailureOnce(error: unknown): void {
  if (warnedInternalFailure) return;
  warnedInternalFailure = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `[Runtime Inspector] __riAnimationConfig failed and returned the original animation config: ${reason}`
  );
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
