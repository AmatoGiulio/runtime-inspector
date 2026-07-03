import { useEffect, useRef } from "react";
import type { CubicBezier, SpringValue } from "@runtime-inspector/protocol";
import type { SharedValueLike } from "./index";
import { registerRuntimeValue, type InspectMeta, type RuntimeValueRegistration } from "./auto";
import { defaultMakeMutable, inferKindFromValue } from "./use-inspector";

declare const __DEV__: boolean | undefined;

export interface TunableRangeOptions {
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label?: string;
  onChange?: (value: number) => void;
}

export interface TunableOptions<T> {
  label?: string;
  onChange?: (value: T) => void;
}

/** Minimal shape of the `makeMutable` export from `react-native-reanimated`. */
type MakeMutable = <T>(value: T) => SharedValueLike<T>;

interface BuiltTunable {
  handle: unknown;
  registration: RuntimeValueRegistration;
}

/**
 * Pure construction of the handle + registry registration for `useTunable`,
 * extracted so tests don't need to render a component (same technique as
 * `buildInspector` in `./use-inspector`). `useTunable` wraps this with the
 * `useRef`/`useEffect` mount lifecycle.
 */
export function buildTunable(
  name: string,
  initial: number | boolean | string | SpringValue | CubicBezier | ((...args: never[]) => unknown),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any = {},
  makeMutable: MakeMutable = defaultMakeMutable
): BuiltTunable {
  const isTrigger = typeof initial === "function";

  if (!isTrigger && inferKindFromValue(initial) === "slider") {
    const rangeOptions = options as Partial<TunableRangeOptions>;
    if (rangeOptions.min === undefined || rangeOptions.max === undefined) {
      throw new Error(
        `useTunable: "${name}" is a bare number. Sliders require an explicit range - ` +
          `write useTunable("${name}", ${initial}, { min: <number>, max: <number> }).`
      );
    }
  }

  const handle = isTrigger ? initial : makeMutable(initial);

  const meta: InspectMeta = {
    min: (options as Partial<TunableRangeOptions>).min,
    max: (options as Partial<TunableRangeOptions>).max,
    step: (options as Partial<TunableRangeOptions>).step,
    unit: (options as Partial<TunableRangeOptions>).unit,
    label: (options as Partial<TunableRangeOptions>).label
  };

  const registration: RuntimeValueRegistration = isTrigger
    ? { kind: "trigger", name, meta, handler: handle as () => void }
    : {
        kind: "value",
        name,
        sharedValue: handle as SharedValueLike<unknown>,
        meta,
        onChange: options.onChange as ((value: unknown) => void) | undefined,
        target: (handle as SharedValueLike<unknown>).value
      };

  return { handle, registration };
}

export function useTunable(name: string, initial: number, options: TunableRangeOptions): SharedValueLike<number>;
export function useTunable(
  name: string,
  initial: boolean,
  options?: TunableOptions<boolean>
): SharedValueLike<boolean>;
export function useTunable(name: string, initial: string, options?: TunableOptions<string>): SharedValueLike<string>;
export function useTunable(
  name: string,
  initial: SpringValue,
  options?: TunableOptions<SpringValue>
): SharedValueLike<SpringValue>;
export function useTunable(
  name: string,
  initial: CubicBezier,
  options?: TunableOptions<CubicBezier>
): SharedValueLike<CubicBezier>;
export function useTunable<TFn extends (...args: never[]) => unknown>(name: string, initial: TFn): TFn;
export function useTunable(
  name: string,
  initial: number | boolean | string | SpringValue | CubicBezier | ((...args: never[]) => unknown),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any = {}
): unknown {
  const ref = useRef<BuiltTunable | undefined>(undefined);
  if (!ref.current) {
    ref.current = buildTunable(name, initial, options);
  }
  const { handle, registration } = ref.current;

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    return registerRuntimeValue(registration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handle;
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
