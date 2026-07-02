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
  bindSharedValue,
  bindTrigger,
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
}

export interface SpringSpecEntry extends SpringValue {
  label?: string;
}

export type InspectorSpecEntry =
  | SliderSpecEntry
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
};

type InferredValue<T> = T extends SliderSpecEntry
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

  for (const [key, entry] of Object.entries(spec)) {
    const binding = `${id}.${key}`;
    const built = inferControl(key, entry, binding, makeMutable);
    controls.push(built.control);
    handles[key] = built.handle;
  }

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
  entry: unknown,
  binding: string,
  makeMutable: MakeMutable
): BuiltEntry {
  const label = (typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as { label?: string }).label
    : undefined) ?? deriveLabel(key);

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
    bindSharedValue(binding, handle);
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
    bindSharedValue(binding, handle);
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
    bindSharedValue(binding, handle);
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
    bindSharedValue(binding, handle);
    return { control, handle };
  }

  if (isSliderEntry(entry)) {
    const handle = makeMutable(entry.value);
    const control: SliderControl = sliderControl({
      id: key,
      label,
      defaultValue: entry.value,
      min: entry.min,
      max: entry.max,
      ...(entry.step !== undefined ? { step: entry.step } : {}),
      ...(entry.unit !== undefined ? { unit: entry.unit } : {}),
      binding
    });
    bindSharedValue(binding, handle);
    return { control, handle };
  }

  throw new Error(
    `useInspector: could not infer a control kind for "${key}" from value ${JSON.stringify(entry)}. ` +
      `Supported shapes: { value, min, max }, boolean, string, { damping, stiffness }, a 4-number array, or a function.`
  );
}

let cachedMakeMutable: MakeMutable | undefined;
let warnedNoReanimated = false;

function defaultMakeMutable<T>(value: T): SharedValueLike<T> {
  if (cachedMakeMutable === undefined) {
    cachedMakeMutable = loadMakeMutable();
  }
  if (cachedMakeMutable) {
    return cachedMakeMutable(value);
  }
  if (!warnedNoReanimated) {
    warnedNoReanimated = true;
    console.warn(
      "[Runtime Inspector] react-native-reanimated's makeMutable is unavailable - falling back to a plain " +
        "{ value } object. Worklet-driven styles that read this handle will not update on the UI thread; " +
        "install react-native-reanimated to restore that behavior."
    );
  }
  return { value };
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
