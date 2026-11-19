import { useEffect, useRef } from "react";
import type {
  BezierControl,
  ColorControl,
  InspectorControl,
  LiteralAnchor,
  PanelSchema,
  SliderControl,
  SourceAnchor,
  SpringControl,
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
} from "./core";
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
  /** Structural source-declaration anchor emitted by the babel plugin (RFC 0004). Forwarded
   * as-is onto the published control's `source` field; not validated here (the schema's Zod
   * validates on publish). */
  source?: SourceAnchor;
  /** Animation literal anchor emitted by the babel plugin (RFC 0007). Forwarded as-is onto
   * the published control's `literal` field, like `source`. */
  literal?: LiteralAnchor;
  /** Slider default when it is not the live value: the declared animation literal (RFC 0007),
   * so a control re-registered while tuned still publishes the literal in source as its default
   * and the tuned number as its value. */
  defaultValue?: number;
}

/** Registration mode: "replace" (lifecycle-less, e.g. __riInspect) overwrites its own prior
 * entry in place on re-registration; "claim" (e.g. useRuntimeValue/useAction) suffixes on any live collision. */
type RegistrationMode = "replace" | "claim";

/** A Runtime Value registry entry - either a value binding or a trigger. */
interface ValueEntry {
  kind: "value";
  name: string;
  sharedValue: SharedValueLike<unknown>;
  meta: InspectMeta;
  onChange?: (value: unknown) => void;
  target: unknown;
  mode: RegistrationMode;
  /** The `useRiInspect` instance token that registered it, for disposal on unmount. */
  owner?: string;
}

interface TriggerEntry {
  kind: "trigger";
  name: string;
  meta: InspectMeta;
  handler: () => void;
  mode: RegistrationMode;
}

type RegistryEntry = ValueEntry | TriggerEntry;

/** name (possibly suffixed) -> entry, keyed by the control id used as binding. */
const registry = new Map<string, RegistryEntry>();
/** Tracks live claims per base name, so a live collision gets "name2", "name3", ... */
const liveClaims = new Map<string, number>();

let publishTimer: ReturnType<typeof setTimeout> | undefined;
let panelHandle: { connect: () => void; disconnect: () => void } | undefined;

/**
 * Auto-binding entry point injected by `@runtime-inspector/babel-plugin` for
 * a `// @inspect ...`-annotated `useSharedValue` declaration (see RFC 0002).
 *
 * No-op in production - returns `sharedValue` unchanged and never touches
 * the registry. In development, registers the value in the shared Runtime
 * Value registry (RFC 0003) and (re)publishes the "auto" schema through the
 * normal `definePanel`/`connect()` path, debounced so multiple declarations
 * evaluated back-to-back (e.g. on initial render, or after a hot reload)
 * coalesce into one publish.
 *
 * With an `instance` token from `useRiInspect` (what the plugin emits inside a component),
 * the registration belongs to that mounted instance and is disposed when it unmounts. Without
 * one (a hand-written call, or a declaration the plugin had to wrap in place) it is never
 * disposed, as in RFC 0002.
 */
export function __riInspect<T>(
  sharedValue: SharedValueLike<T>,
  name: string,
  meta: InspectMeta = {},
  instance?: string
): SharedValueLike<T> {
  if (!isDev()) {
    return sharedValue;
  }

  const owner = instance !== undefined ? inspectInstances.get(instance) : undefined;
  if (owner) {
    owner.sharedValue = sharedValue as SharedValueLike<unknown>;
    owner.meta = meta;
  }
  registerInspected(name, sharedValue as SharedValueLike<unknown>, meta, owner ? instance : undefined);

  return sharedValue;
}

function registerInspected(
  name: string,
  sharedValue: SharedValueLike<unknown>,
  meta: InspectMeta,
  owner: string | undefined
): void {
  // Keep the instance's existing id, including a suffix claimed beside useRuntimeValue.
  // Releasing and reclaiming it can allocate an id another mounted instance still owns.
  const previous = owner !== undefined ? ownedControlId(owner) : undefined;
  if (previous !== undefined) {
    registry.set(previous, {
      kind: "value", name: previous, sharedValue, meta, target: sharedValue.value,
      mode: "replace", owner
    });
    schedulePublish();
    return;
  }
  registerRuntimeValue(
    { kind: "value", name, sharedValue, meta, target: sharedValue.value, owner },
    "replace"
  );
}

/** The control id the instance `token` currently owns, if any. */
function ownedControlId(token: string): string | undefined {
  for (const [id, entry] of registry) {
    if (entry.kind === "value" && entry.owner === token) return id;
  }
  return undefined;
}

/** One mounted component instance of a `// @inspect` declaration. */
interface InspectInstance {
  name: string;
  /** The shared value and meta its latest `__riInspect` call recorded. */
  sharedValue?: SharedValueLike<unknown>;
  meta?: InspectMeta;
}

/** Instance token -> instance, while the instance is rendered or mounted. */
const inspectInstances = new Map<string, InspectInstance>();
/** Name -> tokens of the mounted instances, oldest first. */
const mountedInspectTokens = new Map<string, string[]>();
let nextInspectInstance = 0;

/**
 * Injected by `@runtime-inspector/babel-plugin` before the `__riInspect` call of a
 * `// @inspect` declaration inside a component (issue #8). Returns an instance token that
 * `__riInspect` records its registration under, and disposes that registration when the
 * component unmounts, so a screen you navigated away from no longer leaves a slider driving a
 * value nothing renders.
 *
 * Several mounted instances share one control, as before: the latest render owns it. When the
 * owner unmounts, the control moves to the newest instance still mounted, and is removed only
 * with the last one. A newer mount that rendered before an older one's cleanup ran (a
 * navigation) keeps its control. Takes only static data, so the React Compiler neither
 * memoizes the hook nor freezes the shared value.
 */
export function useRiInspect(name: string): string {
  const ref = useRef<{ token: string; instance: InspectInstance } | undefined>(undefined);
  if (ref.current === undefined) {
    ref.current = { token: `${name}#${++nextInspectInstance}`, instance: { name } };
  }
  const { token, instance } = ref.current;
  if (isDev()) {
    inspectInstances.set(token, instance);
  }

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    // Set again: StrictMode runs the cleanup below and then this effect without a render.
    inspectInstances.set(token, instance);
    const tokens = mountedInspectTokens.get(name) ?? [];
    tokens.push(token);
    mountedInspectTokens.set(name, tokens);

    // Recover a registration removed by StrictMode's cleanup. A different replace-mode
    // owner may have rendered but not committed yet; its registration must stay intact.
    const entry = registry.get(name);
    if (
      instance.sharedValue && ownedControlId(token) === undefined &&
      (!entry || entry.mode === "claim")
    ) {
      registerInspected(name, instance.sharedValue, instance.meta ?? {}, token);
    }

    return () => {
      const remaining = (mountedInspectTokens.get(name) ?? []).filter(
        (candidate) => candidate !== token
      );
      if (remaining.length > 0) {
        mountedInspectTokens.set(name, remaining);
      } else {
        mountedInspectTokens.delete(name);
      }
      inspectInstances.delete(token);

      const owned = ownedControlId(token);
      if (owned === undefined) return;
      registry.delete(owned);
      releaseControlId(name);

      for (const heirToken of [...remaining].reverse()) {
        const heir = inspectInstances.get(heirToken);
        if (heir?.sharedValue) {
          registerInspected(name, heir.sharedValue, heir.meta ?? {}, heirToken);
          return;
        }
      }
      schedulePublish();
    };
  }, [name, token, instance]);

  return token;
}

/** Input to `registerRuntimeValue` - a value entry or a trigger entry. */
export type RuntimeValueRegistration =
  | {
      kind: "value";
      name: string;
      sharedValue: SharedValueLike<unknown>;
      meta?: InspectMeta;
      onChange?: (value: unknown) => void;
      target: unknown;
      owner?: string;
    }
  | {
      kind: "trigger";
      name: string;
      meta?: InspectMeta;
      handler: () => void;
    };

/**
 * Registers a Runtime Value (or trigger) into the shared "auto" registry and
 * schedules a debounced republish. Returns a `dispose()` that removes the
 * entry, releases the claimed base name (so a later registration of the same
 * name gets the bare name back, no suffix), and schedules a republish.
 */
export function registerRuntimeValue(
  registration: RuntimeValueRegistration,
  mode: RegistrationMode = "claim"
): () => void {
  // Replace-mode re-registration under the exact base name: overwrite the existing
  // replace-mode entry in place (same control id), no new claim, no warning. This is the
  // __riInspect re-render/hot-reload path - it must be silent and idempotent.
  const existing = registry.get(registration.name);
  if (mode === "replace" && existing && existing.mode === "replace") {
    const entry: RegistryEntry =
      registration.kind === "trigger"
        ? { kind: "trigger", name: registration.name, meta: registration.meta ?? {}, handler: registration.handler, mode }
        : {
            kind: "value",
            name: registration.name,
            sharedValue: registration.sharedValue,
            meta: registration.meta ?? {},
            onChange: registration.onChange,
            target: registration.target,
            mode,
            ...(registration.owner !== undefined ? { owner: registration.owner } : {})
          };
    registry.set(registration.name, entry);
    schedulePublish();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      registry.delete(registration.name);
      releaseControlId(registration.name);
      schedulePublish();
    };
  }

  const controlId = claimControlId(registration.name);

  const entry: RegistryEntry =
    registration.kind === "trigger"
      ? { kind: "trigger", name: controlId, meta: registration.meta ?? {}, handler: registration.handler, mode }
      : {
          kind: "value",
          name: controlId,
          sharedValue: registration.sharedValue,
          meta: registration.meta ?? {},
          onChange: registration.onChange,
          target: registration.target,
          mode,
          ...(registration.owner !== undefined ? { owner: registration.owner } : {})
        };

  registry.set(controlId, entry);
  schedulePublish();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    registry.delete(controlId);
    releaseControlId(registration.name);
    schedulePublish();
  };
}

/** Claims a control id for `name`, suffixing only if `name` currently has a live claimant. */
function claimControlId(name: string): string {
  const count = liveClaims.get(name) ?? 0;
  liveClaims.set(name, count + 1);

  if (count === 0 && !registry.has(name)) {
    return name;
  }

  // A disposal can leave holes below live suffixes; the claim count is not an unused id.
  let suffix = Math.max(2, count + 1);
  while (registry.has(`${name}${suffix}`)) suffix += 1;
  const suffixed = `${name}${suffix}`;
  warnDev(
    `Auto-inspected value "${name}" collides with a previously registered control of the same name - ` +
      `registering it as "${suffixed}" instead. Give the useSharedValue a unique variable name to avoid this.`
  );
  return suffixed;
}

function releaseControlId(name: string): void {
  const count = liveClaims.get(name) ?? 0;
  if (count <= 1) {
    liveClaims.delete(name);
  } else {
    liveClaims.set(name, count - 1);
  }
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
    if (entry.kind === "trigger") {
      const control: TriggerControl = triggerControl({
        id: entry.name,
        label: entry.meta.label ?? deriveLabel(entry.name),
        binding
      });
      controls.push(control);
      bindTrigger(binding, entry.handler);
      continue;
    }

    const control = buildAutoControl(entry, binding);
    if (control) {
      controls.push(control);
      bindValue(binding, (v) => {
        entry.sharedValue.value = v;
        entry.target = v;
        entry.onChange?.(v);
      });
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

function buildAutoControl(entry: ValueEntry, binding: string): InspectorControl | undefined {
  const { name, sharedValue, meta } = entry;
  const label = meta.label ?? deriveLabel(name);
  const value = sharedValue.value;
  const kind = inferKindFromValue(value);
  const sourceField = {
    ...(meta.source !== undefined ? { source: meta.source } : {}),
    ...(meta.literal !== undefined ? { literal: meta.literal } : {})
  };

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
      const defaultValue = meta.defaultValue ?? (value as number);
      const control: SliderControl = sliderControl({
        id: name,
        label,
        defaultValue,
        ...(value !== defaultValue ? { value: value as number } : {}),
        min: meta.min,
        max: meta.max,
        ...(meta.step !== undefined ? { step: meta.step } : {}),
        ...(meta.unit !== undefined ? { unit: meta.unit } : {}),
        ...sourceField,
        binding
      });
      return control;
    }
    case "toggle": {
      const control: ToggleControl = toggleControl({
        id: name,
        label,
        defaultValue: value as boolean,
        ...sourceField,
        binding
      });
      return control;
    }
    case "color": {
      const control: ColorControl = colorControl({
        id: name,
        label,
        defaultValue: value as string,
        ...sourceField,
        binding
      });
      return control;
    }
    case "spring": {
      const control: SpringControl = springControl({
        id: name,
        label,
        defaultValue: value as never,
        ...sourceField,
        binding
      });
      return control;
    }
    case "bezier": {
      const control: BezierControl = bezierControl({
        id: name,
        label,
        defaultValue: value as never,
        ...sourceField,
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
  liveClaims.clear();
  inspectInstances.clear();
  mountedInspectTokens.clear();
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
