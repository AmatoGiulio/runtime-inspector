import { useEffect, useRef } from "react";
import type { RuntimeProbeDescriptor } from "@runtime-inspector/protocol";
import { humanizeIdentifier } from "./motion";
import { registerRuntimeProbe, type RuntimeProbeSource } from "./recording";

declare const __DEV__: boolean | undefined;

/** Meta the Babel plugin emits for an automatic probe (RFC 0008 §5). */
export interface AutoProbeMeta {
  component: string;
  file: string;
}

const AUTO_TRACE_SCHEMA_ID = "auto";
/** `trace.schema.publish` carries at most 16 probes (RFC 0005); more would be rejected. */
const MAX_AUTO_PROBES = 16;

interface AutoProbeEntry {
  /** The latest mounted shared value; the registered source reads through it. */
  current: { value: unknown };
  refs: number;
  dispose: () => void;
}

/** `<component>.<name>` -> the one registration shared by every mounted instance. */
const autoProbes = new Map<string, AutoProbeEntry>();
let warnedProbeCap = false;

/**
 * Injected by `@runtime-inspector/babel-plugin` around an animated top-level
 * `useSharedValue(<number or boolean literal>)` (RFC 0008 §5). Registers a probe in the `auto`
 * trace schema, labelled `<Humanized component> · <name>`, while the component is mounted, and
 * returns the shared value unchanged. Composes with `__riInspect`. In production it only
 * returns the shared value (the hook is still called unconditionally).
 */
export function __riProbe<T>(sharedValue: T, name: string, meta: AutoProbeMeta): T {
  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    return acquireAutoProbe(sharedValue, name, meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedValue, name, meta.component]);

  return sharedValue;
}

/** One mounted component instance's probe: the shared value its render recorded. */
interface ProbeInstance {
  sharedValue?: unknown;
}

/** Instance token -> instance, for `__riProbeValue`. Entries live while the instance is mounted. */
const probeInstances = new Map<string, ProbeInstance>();
let nextProbeInstance = 0;

/**
 * Injected by `@runtime-inspector/babel-plugin` after an animated top-level
 * `useSharedValue(<literal>)` declaration (RFC 0008 §5, amended 2026-10-30), paired with
 * `__riProbeValue`. Registers the probe while this component instance is mounted, reading
 * the shared value the instance recorded. Takes only static data and returns an instance
 * token, so the React Compiler does not freeze the shared value.
 */
export function useRiProbe(name: string, meta: AutoProbeMeta): string {
  const ref = useRef<{ token: string; instance: ProbeInstance } | undefined>(undefined);
  if (ref.current === undefined) {
    ref.current = { token: `${meta.component}.${name}#${++nextProbeInstance}`, instance: {} };
  }
  const { token, instance } = ref.current;
  if (isDev()) {
    probeInstances.set(token, instance);
  }

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    probeInstances.set(token, instance);
    const release = acquireAutoProbe(instance.sharedValue, name, meta);
    return () => {
      release?.();
      probeInstances.delete(token);
    };
    // `meta` is static per call site; the probe is keyed by component and name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, meta.component, token, instance]);

  return token;
}

/**
 * Injected with `useRiProbe`: records the shared value of the instance `token` and returns it
 * unchanged. Not a hook.
 */
export function __riProbeValue<T>(token: string, sharedValue: T): T {
  const instance = probeInstances.get(token);
  if (instance) {
    instance.sharedValue = sharedValue;
  }
  return sharedValue;
}

/**
 * The non-React core of `__riProbe`. Registers the probe once per (component, name); later
 * instances share it and the source follows the latest one. Returns a release function, or
 * `undefined` when nothing was registered (production, a non number/boolean value, or the
 * 16-probe cap of the `auto` trace schema).
 */
export function acquireAutoProbe(
  sharedValue: unknown,
  name: string,
  meta: AutoProbeMeta
): (() => void) | undefined {
  if (!isDev()) return undefined;
  if (typeof sharedValue !== "object" || sharedValue === null) return undefined;

  let initial: unknown;
  try {
    initial = (sharedValue as { value: unknown }).value;
  } catch {
    return undefined;
  }
  if (typeof initial !== "number" && typeof initial !== "boolean") return undefined;

  const id = `${meta.component}.${name}`;
  let entry = autoProbes.get(id);
  if (entry) {
    entry.current = sharedValue as { value: unknown };
    entry.refs += 1;
  } else {
    if (autoProbes.size >= MAX_AUTO_PROBES) {
      if (!warnedProbeCap) {
        warnedProbeCap = true;
        console.warn(
          `[Runtime Inspector] Not recording "${id}": at most ${MAX_AUTO_PROBES} automatic probes can be ` +
            "registered at once. Probes of screens that unmount free their slots."
        );
      }
      return undefined;
    }

    const created: AutoProbeEntry = {
      current: sharedValue as { value: unknown },
      refs: 1,
      dispose: () => undefined
    };
    const source = {
      get value() {
        return created.current.value;
      }
    } as RuntimeProbeSource;
    const descriptor: RuntimeProbeDescriptor = {
      id,
      valueType: typeof initial === "boolean" ? "boolean" : "number",
      label: `${humanizeIdentifier(meta.component)} · ${name}`
    };
    autoProbes.set(id, created);
    created.dispose = registerRuntimeProbe(AUTO_TRACE_SCHEMA_ID, descriptor, source);
    entry = created;
  }

  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0 || autoProbes.get(id) !== held) return;
    autoProbes.delete(id);
    held.dispose();
  };
}

/** Test-only: drops every automatic probe registration. */
export function __resetAutoProbesForTests(): void {
  probeInstances.clear();
  for (const entry of autoProbes.values()) {
    entry.dispose();
  }
  autoProbes.clear();
  warnedProbeCap = false;
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
