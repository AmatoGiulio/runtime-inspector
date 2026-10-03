import { useEffect, useRef } from "react";
import { bindScene, type SceneHandle } from "./scenes";

declare const __DEV__: boolean | undefined;

/** Meta the Babel plugin emits for an automatic motion (RFC 0008 §2). */
export interface MotionMeta {
  component: string;
  /** The function name, or "effect" for a pure-motion effect. */
  name: string;
  file: string;
  line: number;
  /** From a `// @scene "Title"` comment. */
  title?: string;
  /** From a `// @scene group="Group"` comment. */
  group?: string;
  /** Callsite ids of the animations inside the motion. */
  callsites: string[];
}

/**
 * Injected by `@runtime-inspector/babel-plugin` around (or after) an automatic motion
 * function (RFC 0008). A hook: on mount it binds the RFC 0006 scene `id`, playing the latest
 * `fn`; on unmount it unbinds. Returns `fn` unchanged, so identity, dependency arrays and
 * callers behave exactly as before. In production it only returns `fn` (the hooks are still
 * called unconditionally, like `useAction`).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export function __riMotion<T extends Function>(id: string, fn: T, meta: MotionMeta): T {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const metaRef = useRef(meta);
  metaRef.current = meta;

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    const handle = bindMotion(id, () => (fnRef.current as unknown as () => unknown)(), metaRef.current);
    return () => handle.dispose();
  }, [id]);

  return fn;
}

/**
 * The non-React core of `__riMotion`: binds the automatic scene with the humanized defaults
 * and the motion's callsites (used for "already ran" detection).
 */
export function bindMotion(id: string, play: () => void, meta: MotionMeta): SceneHandle {
  return bindScene(id, play, {
    title: meta.title ?? motionTitle(meta.name),
    group: meta.group ?? humanizeIdentifier(meta.component),
    callsites: meta.callsites
  });
}

/** "replayTransition" -> "Replay transition"; an effect is "On mount". */
export function motionTitle(name: string): string {
  return name === "effect" ? "On mount" : humanizeIdentifier(name);
}

/** "ProductRevealDemo" -> "Product reveal demo", "replayTransition" -> "Replay transition". */
export function humanizeIdentifier(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const joined = words.join(" ");
  if (!joined) return name;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
