import { useEffect, useRef } from "react";
import type { CubicBezier, SpringValue } from "@runtime-inspector/protocol";
import type { SharedValueLike } from "./index";
import { registerRuntimeValue, type InspectMeta, type RuntimeValueRegistration } from "./auto";
import { defaultMakeMutable, inferKindFromValue } from "./use-inspector";

declare const __DEV__: boolean | undefined;

export interface RuntimeValueRangeOptions {
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label?: string;
  onChange?: (value: number) => void;
}

export interface RuntimeValueOptions<T> {
  label?: string;
  onChange?: (value: T) => void;
}

/** Minimal shape of the `makeMutable` export from `react-native-reanimated`. */
type MakeMutable = <T>(value: T) => SharedValueLike<T>;

interface BuiltRuntimeValue {
  handle: unknown;
  registration: RuntimeValueRegistration;
}

/**
 * Pure construction of the handle + registry registration for `useRuntimeValue`,
 * extracted so tests don't need to render a component (same technique as
 * `buildInspector` in `./use-inspector`). `useRuntimeValue` wraps this with the
 * `useRef`/`useEffect` mount lifecycle.
 */
export function buildRuntimeValue(
  name: string,
  initial: number | boolean | string | SpringValue | CubicBezier | ((...args: never[]) => unknown),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any = {},
  makeMutable: MakeMutable = defaultMakeMutable
): BuiltRuntimeValue {
  if (typeof initial === "function") {
    throw new Error(
      `useRuntimeValue: "${name}" is a function. Actions are declared explicitly - ` +
        `use useAction("${name}", fn) instead.`
    );
  }

  if (inferKindFromValue(initial) === "slider") {
    const rangeOptions = options as Partial<RuntimeValueRangeOptions>;
    if (rangeOptions.min === undefined || rangeOptions.max === undefined) {
      throw new Error(
        `useRuntimeValue: "${name}" is a bare number. Sliders require an explicit range - ` +
          `write useRuntimeValue("${name}", ${initial}, { min: <number>, max: <number> }).`
      );
    }
  }

  const handle = makeMutable(initial);

  const meta: InspectMeta = {
    min: (options as Partial<RuntimeValueRangeOptions>).min,
    max: (options as Partial<RuntimeValueRangeOptions>).max,
    step: (options as Partial<RuntimeValueRangeOptions>).step,
    unit: (options as Partial<RuntimeValueRangeOptions>).unit,
    label: (options as Partial<RuntimeValueRangeOptions>).label
  };

  const registration: RuntimeValueRegistration = {
    kind: "value",
    name,
    sharedValue: handle as SharedValueLike<unknown>,
    meta,
    onChange: options.onChange as ((value: unknown) => void) | undefined,
    target: (handle as SharedValueLike<unknown>).value
  };

  return { handle, registration };
}

export function useRuntimeValue(
  name: string,
  initial: number,
  options: RuntimeValueRangeOptions
): SharedValueLike<number>;
export function useRuntimeValue(
  name: string,
  initial: boolean,
  options?: RuntimeValueOptions<boolean>
): SharedValueLike<boolean>;
export function useRuntimeValue(
  name: string,
  initial: string,
  options?: RuntimeValueOptions<string>
): SharedValueLike<string>;
export function useRuntimeValue(
  name: string,
  initial: SpringValue,
  options?: RuntimeValueOptions<SpringValue>
): SharedValueLike<SpringValue>;
export function useRuntimeValue(
  name: string,
  initial: CubicBezier,
  options?: RuntimeValueOptions<CubicBezier>
): SharedValueLike<CubicBezier>;
export function useRuntimeValue(
  name: string,
  initial: number | boolean | string | SpringValue | CubicBezier,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any = {}
): unknown {
  const ref = useRef<BuiltRuntimeValue | undefined>(undefined);
  if (!ref.current) {
    ref.current = buildRuntimeValue(name, initial, options);
  }
  const { handle, registration } = ref.current;

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    return registerRuntimeValue(registration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // returns the runtime-native mutable value (in React Native, a Reanimated mutable)
  return handle;
}

/**
 * Registers a Runtime Action: an explicit, named trigger entry in the shared
 * registry (RFC 0003). Unlike `useRuntimeValue`, actions are never inferred
 * from a function initial - they are declared.
 *
 * Handler identity: a stable wrapper is registered once (on mount) that calls
 * whatever the latest `handler` closure is via a ref, so re-renders with a
 * new closure don't need re-registration and the panel always fires fresh
 * state. Disposes on unmount. Dev-only: in production this is a no-op that
 * just returns `handler` unchanged.
 */
export function useAction(name: string, handler: () => void, options: { label?: string } = {}): () => void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const stableWrapper = useRef<() => void>(undefined as unknown as () => void);
  if (!stableWrapper.current) {
    stableWrapper.current = () => handlerRef.current();
  }

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    const registration: RuntimeValueRegistration = {
      kind: "trigger",
      name,
      meta: { label: options.label },
      handler: stableWrapper.current
    };
    return registerRuntimeValue(registration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handler;
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
