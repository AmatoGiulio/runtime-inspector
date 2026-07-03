import { useEffect, useRef } from "react";
import type {
  BezierControl,
  ColorControl,
  CubicBezier,
  InspectorControl,
  PanelSchema,
  SliderControl,
  SpringControl,
  SpringValue,
  ToggleControl,
  TriggerControl
} from "@runtime-inspector/protocol";
import {
  bindTrigger,
  bindValue,
  bezier as bezierControl,
  color as colorControl,
  definePanel,
  group,
  slider as sliderControl,
  spring as springControl,
  toggle as toggleControl,
  trigger as triggerControl,
  type RuntimeInspectorOptions,
  type SharedValueLike
} from "./index";

/** Minimal shape of the `makeMutable` export from `react-native-reanimated`. */
type MakeMutable = <T>(value: T) => SharedValueLike<T>;

/**
 * A slider entry requires an explicit range. A bare `number` is intentionally
 * NOT accepted as shorthand - the range would be ambiguous - see `inferControl`.
 */
export interface SliderSpecEntry {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  label?: string;
  onChange?: (value: number) => void;
}

export interface SpringSpecEntry extends SpringValue {
  label?: string;
  onChange?: (value: SpringValue) => void;
}

export interface ToggleSpecEntry {
  value: boolean;
  label?: string;
  onChange?: (value: boolean) => void;
}

export interface ColorSpecEntry {
  value: string;
  label?: string;
  onChange?: (value: string) => void;
}

export interface BezierSpecEntry {
  value: CubicBezier;
  label?: string;
  onChange?: (value: CubicBezier) => void;
}

/** A spring value wrapped in `{ value, label?, onChange? }` form. */
export interface WrappedSpringSpecEntry {
  value: SpringValue;
  label?: string;
  onChange?: (value: SpringValue) => void;
}

export type InspectorSpecEntry =
  | SliderSpecEntry
  | ToggleSpecEntry
  | ColorSpecEntry
  | BezierSpecEntry
  | WrappedSpringSpecEntry
  | boolean
  | string
  | SpringSpecEntry
  | CubicBezier
  | ((...args: never[]) => unknown);

export type InspectorSpec = Record<string, InspectorSpecEntry>;

/**
 * The value returned to the caller for each spec key: a SharedValue-like
 * mutable for value controls, or the original function for triggers.
 */
export type InspectorHandles<TSpec extends InspectorSpec = InspectorSpec> = {
  [K in keyof TSpec]: TSpec[K] extends (...args: never[]) => unknown
    ? TSpec[K]
    : SharedValueLike<InferredValue<TSpec[K]>>;
} & {
  $targets: {
    [K in keyof TSpec as TSpec[K] extends (...args: never[]) => unknown ? never : K]: InferredValue<TSpec[K]>;
  };
};

type InferredValue<T> = T extends { value: number }
  ? number
  : T extends { value: boolean }
    ? boolean
    : T extends { value: string }
      ? string
      : T extends { value: SpringValue }
        ? SpringValue
        : T extends { value: CubicBezier }
          ? CubicBezier
          : T extends SliderSpecEntry
            ? number
            : T extends boolean
              ? boolean
              : T extends string
                ? string
                : T extends SpringSpecEntry
                  ? SpringValue
                  : T extends CubicBezier
                    ? CubicBezier
                    : never;

/** camelCase -> "Camel Case", with the first letter capitalized. */
export function deriveLabel(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const withSpaces = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return withSpaces;
}

function isSliderEntry(value: unknown): value is SliderSpecEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "value" in value &&
    typeof (value as SliderSpecEntry).value === "number" &&
    "min" in value &&
    "max" in value
  );
}

function isSpringEntry(value: unknown): value is SpringSpecEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as SpringSpecEntry).damping === "number" &&
    typeof (value as SpringSpecEntry).stiffness === "number"
  );
}

function isBezierEntry(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * A "wrapper" entry is a non-array object carrying a `value` property whose
 * value is itself the thing to infer a kind from (boolean/string/spring
 * object/bezier tuple). The slider shape (`{ value: number, min, max }`) is
 * NOT a wrapper - it already IS the number's spec-object form, with `min`/
 * `max` alongside `value` at the same level, so it's excluded here and
 * handled directly by `isSliderEntry` in `inferControl`.
 */
function isWrapperEntry(entry: unknown): entry is { value: unknown; label?: string; onChange?: (value: never) => void } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    "value" in entry &&
    // A bare spring shape (`{ damping, stiffness }`) has no `value` key, so
    // it never reaches here - no ambiguity with the wrapped spring form.
    !isSpringEntry(entry) &&
    !isSliderEntry(entry)
  );
}

/**
 * The subset of control kinds that can be inferred purely from a value's
 * runtime shape (no spec object), shared between `useInspector`'s spec-based
 * inference and the auto-binding helper (`__riInspect`, see `./auto`), which
 * only has a live value + optional numeric range metadata.
 */
export type InferredKind = "slider" | "toggle" | "color" | "spring" | "bezier";

/**
 * Infers a control kind from a raw value's shape - the same inference table
 * `useInspector` uses (number->slider, boolean->toggle, string->color,
 * spring shape->spring, 4-array->bezier). Does not inspect any spec-object
 * wrapper (`{ value, min, max }`) - callers with a bare number must supply
 * `min`/`max` out of band (see `RFC 0002`/`__riInspect`).
 */
export function inferKindFromValue(value: unknown): InferredKind | undefined {
  if (typeof value === "number") return "slider";
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "string") return "color";
  if (isSpringEntry(value)) return "spring";
  if (isBezierEntry(value) && value.length === 4 && value.every((part) => typeof part === "number")) {
    return "bezier";
  }
  return undefined;
}

interface BuiltEntry {
  control: InspectorControl;
  handle: unknown;
}

/**
 * Pure construction of the panel schema + handles from a spec. Does not
 * connect to any broker - `useInspector` wraps this with connect/disconnect
 * lifecycle. Exported for tests.
 */
export function buildInspector(
  id: string,
  spec: InspectorSpec,
  options: { title?: string; makeMutable?: MakeMutable } = {}
): { schema: PanelSchema; handles: InspectorHandles } {
  const makeMutable: MakeMutable = options.makeMutable ?? defaultMakeMutable;
  const controls: InspectorControl[] = [];
  const handles: Record<string, unknown> = {};
  const targets: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(spec)) {
    if (key.startsWith("$")) {
      throw new Error(
        `useInspector: control key "${key}" starts with "$", which is reserved for the returned $targets object. ` +
          `Rename this key.`
      );
    }
    const binding = `${id}.${key}`;
    const built = inferControl(key, entry, binding, makeMutable, targets);
    controls.push(built.control);
    handles[key] = built.handle;
  }

  handles.$targets = targets;

  const schema: PanelSchema = {
    id,
    title: options.title ?? id,
    groups: [
      group({
        id: "controls",
        label: "Controls",
        controls
      })
    ]
  };

  return { schema, handles: handles as InspectorHandles };
}

function inferControl(
  key: string,
  rawEntry: unknown,
  binding: string,
  makeMutable: MakeMutable,
  targets: Record<string, unknown>
): BuiltEntry {
  // A wrapper (`{ value, label?, onChange? }`) is inferred from the shape of
  // its `value` property; a bare entry is inferred from its own shape. Both
  // paths share the code below via `entry` (the value to infer a kind from)
  // and `label`/`onChange` (pulled from the wrapper when present).
  const wrapper = isWrapperEntry(rawEntry) ? rawEntry : undefined;
  const entry: unknown = wrapper ? wrapper.value : rawEntry;
  // The slider shape (`{ value, min, max, onChange? }`) already carries
  // `label`/`onChange` at its own top level - it's excluded from
  // `isWrapperEntry`, so pull them straight off `rawEntry` there too.
  const bareLabelOnChangeSource =
    typeof rawEntry === "object" && rawEntry !== null && !Array.isArray(rawEntry)
      ? (rawEntry as { label?: string; onChange?: (value: never) => void })
      : undefined;
  const onChange = wrapper?.onChange ?? bareLabelOnChangeSource?.onChange;
  const label = (wrapper ? wrapper.label : bareLabelOnChangeSource?.label) ?? deriveLabel(key);

  if (typeof entry === "number") {
    throw new Error(
      `useInspector: control "${key}" is a bare number. Sliders require an explicit range - ` +
        `write { value: ${entry}, min: <number>, max: <number> } instead of ${entry}.`
    );
  }

  if (typeof entry === "function") {
    const control: TriggerControl = triggerControl({
      id: key,
      label,
      binding
    });
    bindTrigger(binding, entry as () => void);
    return { control, handle: entry };
  }

  if (typeof entry === "boolean") {
    const handle = makeMutable(entry);
    const control: ToggleControl = toggleControl({
      id: key,
      label,
      defaultValue: entry,
      binding
    });
    targets[key] = entry;
    bindValue(binding, (v) => {
      handle.value = v as boolean;
      targets[key] = v;
      (onChange as ((value: boolean) => void) | undefined)?.(v as boolean);
    });
    return { control, handle };
  }

  if (typeof entry === "string") {
    const handle = makeMutable(entry);
    const control: ColorControl = colorControl({
      id: key,
      label,
      defaultValue: entry,
      binding
    });
    targets[key] = entry;
    bindValue(binding, (v) => {
      handle.value = v as string;
      targets[key] = v;
      (onChange as ((value: string) => void) | undefined)?.(v as string);
    });
    return { control, handle };
  }

  if (isBezierEntry(entry)) {
    if (entry.length !== 4) {
      throw new Error(
        `useInspector: control "${key}" is an array of length ${entry.length}. Bezier controls require ` +
          `exactly 4 numbers ([x1, y1, x2, y2]).`
      );
    }
    if (!entry.every((part) => typeof part === "number" && Number.isFinite(part))) {
      throw new Error(
        `useInspector: control "${key}" must be a 4-tuple of finite numbers ([x1, y1, x2, y2]), got ${JSON.stringify(entry)}.`
      );
    }
    const value = entry as CubicBezier;
    const handle = makeMutable(value);
    const control: BezierControl = bezierControl({
      id: key,
      label,
      defaultValue: value,
      binding
    });
    targets[key] = value;
    bindValue(binding, (v) => {
      handle.value = v as CubicBezier;
      targets[key] = v;
      (onChange as ((value: CubicBezier) => void) | undefined)?.(v as CubicBezier);
    });
    return { control, handle };
  }

  if (isSpringEntry(entry)) {
    const value: SpringValue = {
      damping: entry.damping,
      stiffness: entry.stiffness,
      ...(entry.mass !== undefined ? { mass: entry.mass } : {})
    };
    const handle = makeMutable(value);
    const control: SpringControl = springControl({
      id: key,
      label,
      defaultValue: value,
      binding
    });
    targets[key] = value;
    bindValue(binding, (v) => {
      handle.value = v as SpringValue;
      targets[key] = v;
      (onChange as ((value: SpringValue) => void) | undefined)?.(v as SpringValue);
    });
    return { control, handle };
  }

  if (isSliderEntry(entry)) {
    const sliderEntry = entry;
    const handle = makeMutable(sliderEntry.value);
    const control: SliderControl = sliderControl({
      id: key,
      label,
      defaultValue: sliderEntry.value,
      min: sliderEntry.min,
      max: sliderEntry.max,
      ...(sliderEntry.step !== undefined ? { step: sliderEntry.step } : {}),
      ...(sliderEntry.unit !== undefined ? { unit: sliderEntry.unit } : {}),
      binding
    });
    targets[key] = sliderEntry.value;
    bindValue(binding, (v) => {
      handle.value = v as number;
      targets[key] = v;
      (onChange as ((value: number) => void) | undefined)?.(v as number);
    });
    return { control, handle };
  }

  throw new Error(
    `useInspector: could not infer a control kind for "${key}" from value ${JSON.stringify(entry)}. ` +
      `Supported shapes: { value, min, max }, boolean, string, { damping, stiffness }, a 4-number array, or a function.`
  );
}

let cachedMakeMutable: MakeMutable | undefined;

function defaultMakeMutable<T>(value: T): SharedValueLike<T> {
  if (cachedMakeMutable === undefined) {
    cachedMakeMutable = loadMakeMutable();
  }
  if (cachedMakeMutable) {
    return cachedMakeMutable(value);
  }
  throw new Error(
    "[Runtime Inspector] react-native-reanimated is required by useInspector: its makeMutable export was not " +
      "found. Install react-native-reanimated, or use the explicit API (definePanel + bindValue) for " +
      "non-animated values."
  );
}

function loadMakeMutable(): MakeMutable | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reanimated = require("react-native-reanimated") as {
      makeMutable?: MakeMutable;
    };
    return reanimated?.makeMutable;
  } catch {
    return undefined;
  }
}

/**
 * Declarative sugar over `definePanel` + the explicit binding helpers.
 *
 * The schema and handles are built exactly once (on first render, via
 * `useRef`) - changes to `spec`'s identity across re-renders are ignored by
 * design, matching the "define once, mutate via handles" model of the
 * explicit API. Connects on mount and disconnects on unmount.
 */
export function useInspector<TSpec extends InspectorSpec>(
  id: string,
  spec: TSpec,
  options: RuntimeInspectorOptions & { title?: string } = {}
): InspectorHandles<TSpec> {
  const ref = useRef<{ schema: PanelSchema; handles: InspectorHandles } | undefined>(undefined);
  if (!ref.current) {
    ref.current = buildInspector(id, spec, { title: options.title });
  }
  const { schema, handles } = ref.current;

  useEffect(() => {
    const panel = definePanel(schema, options);
    panel.connect();
    return () => {
      panel.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handles as InspectorHandles<TSpec>;
}
