import type {
  BezierControl,
  ColorControl,
  InspectorControl,
  PanelSchema,
  SliderControl,
  SpringControl,
  ToggleControl
} from "@runtime-inspector/protocol";
import {
  bindSharedValue,
  bezier as bezierControl,
  color as colorControl,
  definePanel,
  group,
  slider as sliderControl,
  spring as springControl,
  toggle as toggleControl,
  type RuntimeInspectorOptions,
  type SharedValueLike
} from "./index";
import { deriveLabel, inferKindFromValue } from "./use-inspector";

declare const __DEV__: boolean | undefined;

const AUTO_SCHEMA_ID = "auto";
const AUTO_SCHEMA_TITLE = "Inspected values";
const DEBOUNCE_MS = 100;

export interface InspectMeta {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
}

interface RegistryEntry {
  name: string;
  sharedValue: SharedValueLike<unknown>;
  meta: InspectMeta;
}

/** name -> entry, keyed by the (possibly-suffixed) control id used as binding. */
const registry = new Map<string, RegistryEntry>();
/** Tracks base names already used, so collisions get "name2", "name3", ... */
const nameUsageCount = new Map<string, number>();

let publishTimer: ReturnType<typeof setTimeout> | undefined;
let panelHandle: { connect: () => void; disconnect: () => void } | undefined;

/**
 * Auto-binding entry point injected by `@runtime-inspector/babel-plugin` for
 * a `// @inspect ...`-annotated `useSharedValue` declaration (see RFC 0002).
 *
 * No-op in production - returns `sharedValue` unchanged and never touches
 * the registry. In development, registers the value in a module-level
 * "auto" schema (single group, one control per registered value) and
 * (re)publishes it through the normal `definePanel`/`connect()` path,
 * debounced so multiple declarations evaluated back-to-back (e.g. on
 * initial render, or after a hot reload) coalesce into one publish.
 */
export function __riInspect<T>(
  sharedValue: SharedValueLike<T>,
  name: string,
  meta: InspectMeta = {}
): SharedValueLike<T> {
  if (!isDev()) {
    return sharedValue;
  }

  const controlId = resolveControlId(name);
  registry.set(controlId, {
    name: controlId,
    sharedValue: sharedValue as SharedValueLike<unknown>,
    meta
  });

  schedulePublish();

  return sharedValue;
}

function resolveControlId(name: string): string {
  const count = nameUsageCount.get(name) ?? 0;
  nameUsageCount.set(name, count + 1);

  if (count === 0) {
    return name;
  }

  const suffixed = `${name}${count + 1}`;
  warnDev(
    `Auto-inspected value "${name}" collides with a previously registered control of the same name - ` +
      `registering it as "${suffixed}" instead. Give the useSharedValue a unique variable name to avoid this.`
  );
  return suffixed;
}

function schedulePublish(): void {
  if (publishTimer) {
    clearTimeout(publishTimer);
  }
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    publish();
  }, DEBOUNCE_MS);
}

function publish(options: RuntimeInspectorOptions = {}): void {
  const schema = buildAutoSchema();

  if (panelHandle) {
    panelHandle.disconnect();
  }

  const panel = definePanel(schema, options);
  panel.connect();
  panelHandle = panel;
}

function buildAutoSchema(): PanelSchema {
  const controls: InspectorControl[] = [];

  for (const entry of registry.values()) {
    const binding = `${AUTO_SCHEMA_ID}.${entry.name}`;
    const control = buildAutoControl(entry, binding);
    if (control) {
      controls.push(control);
      bindSharedValue(binding, entry.sharedValue);
    }
  }

  return {
    id: AUTO_SCHEMA_ID,
    title: AUTO_SCHEMA_TITLE,
    groups: [
      group({
        id: "auto",
        label: "Auto-inspected",
        controls
      })
    ]
  };
}

function buildAutoControl(entry: RegistryEntry, binding: string): InspectorControl | undefined {
  const { name, sharedValue, meta } = entry;
  const label = meta.label ?? deriveLabel(name);
  const value = sharedValue.value;
  const kind = inferKindFromValue(value);

  if (!kind) {
    warnDev(
      `Could not infer a control kind for auto-inspected value "${name}" from ${JSON.stringify(value)} - skipping.`
    );
    return undefined;
  }

  switch (kind) {
    case "slider": {
      if (meta.min === undefined || meta.max === undefined) {
        // Should have been caught at build time by the babel plugin; guard
        // defensively so a hand-written __riInspect call fails loudly too.
        throw new Error(
          `__riInspect: "${name}" has a numeric value but no min/max was provided. ` +
            `Sliders require an explicit range - annotate with "// @inspect min=<number> max=<number>".`
        );
      }
      const control: SliderControl = sliderControl({
        id: name,
        label,
        defaultValue: value as number,
        min: meta.min,
        max: meta.max,
        ...(meta.step !== undefined ? { step: meta.step } : {}),
        ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
        binding
      });
      return control;
    }
    case "toggle": {
      const control: ToggleControl = toggleControl({
        id: name,
        label,
        defaultValue: value as boolean,
        binding
      });
      return control;
    }
    case "color": {
      const control: ColorControl = colorControl({
        id: name,
        label,
        defaultValue: value as string,
        binding
      });
      return control;
    }
    case "spring": {
      const control: SpringControl = springControl({
        id: name,
        label,
        defaultValue: value as never,
        binding
      });
      return control;
    }
    case "bezier": {
      const control: BezierControl = bezierControl({
        id: name,
        label,
        defaultValue: value as never,
        binding
      });
      return control;
    }
    default:
      return undefined;
  }
}

/** Test-only: clears module-level registry state between test runs. */
export function __resetAutoRegistryForTests(): void {
  registry.clear();
  nameUsageCount.clear();
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = undefined;
  }
  panelHandle = undefined;
}

function warnDev(message: string) {
  if (isDev()) {
    console.warn(`[Runtime Inspector] ${message}`);
  }
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
