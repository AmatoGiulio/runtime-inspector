import { useEffect, useRef } from "react";
import { Linking } from "react-native";
import {
  SCENES_SCHEMA_ID,
  type InspectorControl,
  type PanelSchema,
  type SceneDescriptor,
  type SceneFailureCode,
  type SceneStatus,
  type SceneStatusPhase
} from "@runtime-inspector/protocol";
import {
  __resolveDevServerScriptUrl,
  bindTrigger,
  group,
  trigger as triggerControl,
  updatePanelSchema
} from "./index";

declare const __DEV__: boolean | undefined;

/** A named moment of motion: where to go, and what to play once there (RFC 0006). */
export interface SceneDeclaration {
  title?: string;
  group?: string;
  description?: string;
  /** Absolute deep link (myapp://…, https://…) or a path (/product/42), resolved per RFC 0006 §4. */
  link?: string;
  /** Programmatic navigation. Takes precedence over `link` when opening. May return a promise. */
  open?: () => void | Promise<unknown>;
}

export interface UseSceneOptions extends Omit<SceneDeclaration, "open"> {
  /** Defaults to true. Pass the screen's focus state when hidden screens stay mounted (stack navigators). */
  active?: boolean;
}

/** Options of `bindScene`: `useScene` options plus the automatic-motion callsites (RFC 0008 §3). */
export interface BindSceneOptions extends UseSceneOptions {
  /**
   * Callsite ids of the animations inside an automatic motion. When present, the scene counts
   * as already played once any of them reported `animation.started` after the binding became
   * active, instead of relying on the binding's own run function.
   */
  callsites?: readonly string[];
}

export interface ConfigureScenesOptions {
  linkPrefix?: string;
  timeoutMs?: number;
}

/** Handle of one mounted `useScene` binding. */
export interface SceneHandle {
  run(): void;
  setActive(active: boolean): void;
  dispose(): void;
}

type SceneStatusEmitter = (message: SceneStatus) => void;
type FallbackFields = Omit<UseSceneOptions, "active">;

interface SceneBinding {
  play: () => void;
  mounted: boolean;
  activeFlag: boolean;
  activatedAt: number | undefined;
  activationSeq: number;
  lastRunAt: number | undefined;
  /** Automatic motions (RFC 0008): the animation callsites the app's own calls start. */
  callsites: ReadonlySet<string> | undefined;
  /** Latest time one of `callsites` started while the binding was mounted. */
  lastCallsiteStartAt: number | undefined;
}

interface SceneEntry {
  id: string;
  declared: SceneDeclaration;
  fallback: FallbackFields;
  bindings: Set<SceneBinding>;
}

interface PendingOpen {
  sceneId: string;
  /** What was used to navigate: the url, or "open()". */
  via: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  binding: SceneBinding | undefined;
  frameRequested: boolean;
}

const PUBLISH_DEBOUNCE_MS = 50;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_GROUP_KEY = "\u0000scenes";
const DEFAULT_GROUP = { id: "scenes", label: "Scenes" };
const DECLARATION_FIELDS = ["title", "group", "description", "link", "open"] as const;
const FALLBACK_FIELDS = ["title", "group", "description", "link"] as const;

/** Scene id -> entry, in the order ids were first seen. */
const scenes = new Map<string, SceneEntry>();
/** Group keys in first-seen order. */
const groupOrder: string[] = [];
const warnedUnresolvedLink = new Set<string>();
let config: ConfigureScenesOptions = {};
let pendingOpen: PendingOpen | undefined;
let publishTimer: ReturnType<typeof setTimeout> | undefined;
let activationCounter = 0;
// `var`, not `let`: index.ts installs the emitter while this module may still be
// evaluating (index.ts <-> scenes.ts import cycle), and a `let` would be in its TDZ.
// eslint-disable-next-line no-var
var emitSceneStatus: SceneStatusEmitter | undefined;

export function setSceneStatusEmitter(emitter: SceneStatusEmitter): void {
  emitSceneStatus = emitter;
}

/**
 * Declares (or updates) a scene. Fields merge per field: a later call overrides only the
 * fields it sets. Dev-only.
 */
export function defineScene(id: string, declaration: SceneDeclaration): void {
  if (!isDev()) return;
  if (!isValidSceneId(id)) {
    warnDev("Ignoring a scene declared with an empty id.");
    return;
  }

  const entry = ensureScene(id);
  const source = (declaration ?? {}) as Record<string, unknown>;
  const declared = entry.declared as Record<string, unknown>;
  for (const field of DECLARATION_FIELDS) {
    if (source[field] !== undefined) {
      declared[field] = source[field];
    }
  }
  noteGroup(entry);
  schedulePublish();
}

/** `defineScene` for every entry of the map, in key order. Dev-only. */
export function defineScenes(map: Record<string, SceneDeclaration>): void {
  if (!isDev()) return;
  for (const [id, declaration] of Object.entries(map)) {
    defineScene(id, declaration);
  }
}

/** Sets how scene links resolve and how long an open waits for the scene to mount. Dev-only. */
export function configureScenes(options: ConfigureScenesOptions): void {
  if (!isDev()) return;

  if (options.linkPrefix !== undefined) {
    config = { ...config, linkPrefix: options.linkPrefix };
  }
  if (options.timeoutMs !== undefined) {
    if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      config = { ...config, timeoutMs: options.timeoutMs };
    } else {
      warnDev(
        `Ignoring configureScenes({ timeoutMs: ${String(options.timeoutMs)} }): timeoutMs must be a finite number greater than 0.`
      );
    }
  }
  schedulePublish();
}

/**
 * Binds the motion of a scene where it lives. Returns one stable function that runs the
 * latest `play` (recording the run so an opened scene is not played twice). In
 * production it just calls `play` and never touches the registry.
 */
export function useScene(id: string, play: () => void, options: UseSceneOptions = {}): () => void {
  const playRef = useRef(play);
  playRef.current = play;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const handleRef = useRef<SceneHandle | undefined>(undefined);

  const stableRef = useRef<(() => void) | undefined>(undefined);
  if (!stableRef.current) {
    stableRef.current = () => {
      const handle = handleRef.current;
      if (handle) {
        handle.run();
      } else {
        playRef.current();
      }
    };
  }

  useEffect(() => {
    if (!isDev()) {
      return undefined;
    }
    const handle = bindScene(id, () => playRef.current(), optionsRef.current);
    handleRef.current = handle;
    return () => {
      handle.dispose();
      if (handleRef.current === handle) {
        handleRef.current = undefined;
      }
    };
  }, [id]);

  useEffect(() => {
    handleRef.current?.setActive(options.active ?? true);
  }, [options.active]);

  return stableRef.current;
}

/**
 * Registers one binding of a scene (the non-React core of `useScene`). An undeclared id
 * declares itself. The options' title/group/link/description only fill fields no
 * declaration has set.
 */
export function bindScene(sceneId: string, play: () => void, options: BindSceneOptions = {}): SceneHandle {
  if (!isDev() || !isValidSceneId(sceneId)) {
    if (isDev()) {
      warnDev("Ignoring useScene with an empty scene id.");
    }
    return { run: () => play(), setActive: noop, dispose: noop };
  }

  const entry = ensureScene(sceneId);
  const fallback = entry.fallback as Record<string, unknown>;
  const source = options as Record<string, unknown>;
  for (const field of FALLBACK_FIELDS) {
    if (source[field] !== undefined) {
      fallback[field] = source[field];
    }
  }
  noteGroup(entry);

  const binding: SceneBinding = {
    play,
    mounted: true,
    activeFlag: options.active ?? true,
    activatedAt: undefined,
    activationSeq: 0,
    lastRunAt: undefined,
    callsites: options.callsites ? new Set(options.callsites) : undefined,
    lastCallsiteStartAt: undefined
  };
  if (binding.activeFlag) {
    markActivated(binding);
  }
  entry.bindings.add(binding);
  schedulePublish();
  if (binding.activeFlag) {
    onBindingActivated(entry, binding);
  }

  return {
    run: () => runBinding(binding),
    setActive: (active: boolean) => {
      if (!binding.mounted || binding.activeFlag === active) return;
      binding.activeFlag = active;
      if (active) {
        markActivated(binding);
      }
      schedulePublish();
      if (active) {
        onBindingActivated(entry, binding);
      }
    },
    dispose: () => {
      if (!binding.mounted) return;
      binding.mounted = false;
      entry.bindings.delete(binding);
      schedulePublish();
    }
  };
}

/**
 * In-process notification from the animation observer (RFC 0008 §3): an animation call site
 * started at `atMs`. Records it on every mounted automatic binding that lists the callsite,
 * so "already ran" detection sees the app's own calls of its motion function. Best-effort.
 */
export function noteAnimationCallsiteStarted(callsiteId: string, atMs: number): void {
  if (!isDev()) return;
  for (const entry of scenes.values()) {
    for (const binding of entry.bindings) {
      if (binding.mounted && binding.callsites?.has(callsiteId)) {
        binding.lastCallsiteStartAt = atMs;
      }
    }
  }
}

/**
 * Opens a scene (RFC 0006 §3): plays it now when it is on screen, otherwise navigates
 * through `open()` or its url, waits for a binding to become active and plays once.
 * Progress is reported with `scene.status`. Never throws.
 */
export function openScene(sceneId: string): void {
  if (!isDev()) return;

  if (pendingOpen) {
    const superseded = pendingOpen;
    pendingOpen = undefined;
    clearPendingTimer(superseded);
    emitStatus(
      superseded.sceneId,
      "failed",
      nowMs(),
      "SUPERSEDED",
      `Superseded by opening scene "${sceneId}".`
    );
  }

  const entry = scenes.get(sceneId);
  const binding = entry ? mostRecentActiveBinding(entry) : undefined;
  if (entry && binding) {
    playAndReport(sceneId, binding);
    return;
  }

  const open = entry?.declared.open;
  const link = entry ? effectiveField(entry, "link") : undefined;
  const url = resolveSceneLink(link);
  if (!open && url === undefined) {
    const reason =
      link !== undefined
        ? `Scene "${sceneId}" is not on screen, has no open(), and its link "${link}" did not resolve to a url. Call configureScenes({ linkPrefix }) with your app's scheme.`
        : `Scene "${sceneId}" is not on screen and has neither a link nor open().`;
    emitStatus(sceneId, "failed", nowMs(), "UNREACHABLE", reason);
    return;
  }

  const via = open ? "open()" : (url as string);
  emitStatus(sceneId, "navigating", nowMs());
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending: PendingOpen = {
    sceneId,
    via,
    timer: undefined,
    binding: undefined,
    frameRequested: false
  };
  pending.timer = setTimeout(() => {
    pending.timer = undefined;
    if (pendingOpen !== pending) return;
    pendingOpen = undefined;
    const used = via === "open()" ? "Called open()" : `Opened ${via}`;
    emitStatus(
      sceneId,
      "failed",
      nowMs(),
      "MOUNT_TIMEOUT",
      `${used} for scene "${sceneId}" but no useScene("${sceneId}") became active within ${timeoutMs} ms. Check the link, or call useScene("${sceneId}") on the target screen.`
    );
  }, timeoutMs);
  pendingOpen = pending;

  const failNavigation = (error: unknown) => {
    if (pendingOpen !== pending) return;
    pendingOpen = undefined;
    clearPendingTimer(pending);
    emitStatus(
      sceneId,
      "failed",
      nowMs(),
      "NAVIGATION_FAILED",
      errorMessage(error, `Navigating to scene "${sceneId}" failed.`)
    );
  };

  try {
    const result: unknown = open ? open() : Linking.openURL(url as string);
    if (isThenable(result)) {
      result.then(undefined, failNavigation);
    }
  } catch (error) {
    failNavigation(error);
  }
}

/**
 * Resolves a scene link to an absolute url (RFC 0006 §4): absolute links as is; paths
 * through `configureScenes({ linkPrefix })`, then Expo Go's `exp://<host>/--<path>`, then the
 * scheme an Expo development build declares. Returns undefined when nothing resolves.
 * No `require("expo-linking")`: Metro reports a missing optional module as an uncaught
 * error even inside try/catch, so the Expo constants are read directly instead.
 */
export function resolveSceneLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return link;

  const path = link.startsWith("/") ? link : `/${link}`;
  const { linkPrefix } = config;
  if (linkPrefix !== undefined) {
    return linkPrefix.endsWith("/") ? linkPrefix + path.slice(1) : linkPrefix + path;
  }

  const expoGoBase = getExpoGoBaseUrl();
  if (expoGoBase) {
    return `${expoGoBase}/--${path}`;
  }

  const expoScheme = getExpoAppScheme();
  if (expoScheme) {
    return `${expoScheme}://${path.slice(1)}`;
  }

  return undefined;
}

/** Test-only: clears registry, config, pending open, timers and warnings. */
export function __resetScenesForTests(): void {
  scenes.clear();
  groupOrder.length = 0;
  warnedUnresolvedLink.clear();
  config = {};
  if (pendingOpen) {
    clearPendingTimer(pendingOpen);
    pendingOpen = undefined;
  }
  if (publishTimer) {
    clearTimeout(publishTimer);
    publishTimer = undefined;
  }
  activationCounter = 0;
}

function ensureScene(id: string): SceneEntry {
  let entry = scenes.get(id);
  if (!entry) {
    entry = { id, declared: {}, fallback: {}, bindings: new Set() };
    scenes.set(id, entry);
  }
  return entry;
}

function effectiveField(entry: SceneEntry, field: "title" | "group" | "description" | "link"): string | undefined {
  return entry.declared[field] ?? entry.fallback[field];
}

function groupKey(entry: SceneEntry): string {
  return effectiveField(entry, "group") ?? DEFAULT_GROUP_KEY;
}

function noteGroup(entry: SceneEntry): void {
  const key = groupKey(entry);
  if (!groupOrder.includes(key)) {
    groupOrder.push(key);
  }
}

function isBindingActive(binding: SceneBinding): boolean {
  return binding.mounted && binding.activeFlag;
}

function markActivated(binding: SceneBinding): void {
  activationCounter += 1;
  binding.activatedAt = nowMs();
  binding.activationSeq = activationCounter;
}

function mostRecentActiveBinding(entry: SceneEntry): SceneBinding | undefined {
  let latest: SceneBinding | undefined;
  for (const binding of entry.bindings) {
    if (!isBindingActive(binding)) continue;
    if (!latest || binding.activationSeq > latest.activationSeq) {
      latest = binding;
    }
  }
  return latest;
}

function runBinding(binding: SceneBinding): void {
  binding.lastRunAt = nowMs();
  binding.play();
}

function playAndReport(sceneId: string, binding: SceneBinding): void {
  try {
    runBinding(binding);
  } catch (error) {
    const message = errorMessage(error, `The play function of scene "${sceneId}" threw.`);
    warnDev(`Scene "${sceneId}" failed to play: ${message}`);
    emitStatus(sceneId, "failed", nowMs(), "PLAY_FAILED", message);
    return;
  }
  emitStatus(sceneId, "playing", binding.lastRunAt ?? nowMs());
}

function onBindingActivated(entry: SceneEntry, binding: SceneBinding): void {
  const pending = pendingOpen;
  if (!pending || pending.sceneId !== entry.id) return;

  clearPendingTimer(pending);
  pending.binding = binding;
  if (pending.frameRequested) return;
  pending.frameRequested = true;
  requestFrame(() => {
    if (pendingOpen !== pending) return;
    pendingOpen = undefined;
    const target = pending.binding;
    if (!target || !isBindingActive(target)) {
      emitStatus(
        pending.sceneId,
        "failed",
        nowMs(),
        "PLAY_FAILED",
        `Scene "${pending.sceneId}" left the screen before playing.`
      );
      return;
    }
    const ranAt = lastRunSinceActivation(target);
    if (ranAt !== undefined) {
      // The screen already ran its play function since it became active (an entrance).
      emitStatus(pending.sceneId, "playing", ranAt);
      return;
    }
    playAndReport(pending.sceneId, target);
  });
}

/**
 * When the binding's motion already ran since it became active: its own run function for an
 * explicit `useScene`, any of its animation callsites for an automatic motion (RFC 0008 §3).
 */
function lastRunSinceActivation(binding: SceneBinding): number | undefined {
  if (binding.activatedAt === undefined) return undefined;
  const ranAt = binding.callsites ? binding.lastCallsiteStartAt : binding.lastRunAt;
  return ranAt !== undefined && ranAt >= binding.activatedAt ? ranAt : undefined;
}

function clearPendingTimer(pending: PendingOpen): void {
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
}

function emitStatus(
  sceneId: string,
  phase: SceneStatusPhase,
  atRuntimeMs: number,
  code?: SceneFailureCode,
  reason?: string
): void {
  const message: SceneStatus =
    phase === "failed"
      ? { type: "scene.status", sceneId, phase, atRuntimeMs, code, reason }
      : { type: "scene.status", sceneId, phase, atRuntimeMs };
  try {
    emitSceneStatus?.(message);
  } catch {
    // best-effort: scene status is never replayed
  }
}

function schedulePublish(): void {
  if (!isDev()) return;
  if (publishTimer) {
    clearTimeout(publishTimer);
  }
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    publishScenes();
  }, PUBLISH_DEBOUNCE_MS);
}

function publishScenes(): void {
  if (scenes.size === 0) return;
  const schema = buildScenesSchema();
  for (const id of scenes.keys()) {
    bindTrigger(`${SCENES_SCHEMA_ID}.${id}`, () => openScene(id));
  }
  updatePanelSchema(schema);
}

function buildScenesSchema(): PanelSchema {
  const controlsByGroup = new Map<string, InspectorControl[]>();

  for (const entry of scenes.values()) {
    noteGroup(entry);
    const key = groupKey(entry);
    const link = effectiveField(entry, "link");
    const url = resolveSceneLink(link);
    if (link !== undefined && url === undefined && !warnedUnresolvedLink.has(entry.id)) {
      warnedUnresolvedLink.add(entry.id);
      warnDev(
        `Scene "${entry.id}" has the link "${link}" but no url could be resolved, so it can only be opened while it is on screen. ` +
          `Call configureScenes({ linkPrefix: "myapp://" }) with your app's scheme.`
      );
    }

    const active = Array.from(entry.bindings).some(isBindingActive);
    const scene: SceneDescriptor = {
      ...(url !== undefined ? { url } : {}),
      active,
      reachable: active || entry.declared.open !== undefined || url !== undefined
    };
    const title = effectiveField(entry, "title");
    const description = effectiveField(entry, "description");
    const control = triggerControl({
      id: entry.id,
      label: title ? title : deriveSceneTitle(entry.id),
      ...(description !== undefined ? { description } : {}),
      binding: `${SCENES_SCHEMA_ID}.${entry.id}`,
      scene
    });

    const controls = controlsByGroup.get(key) ?? [];
    controls.push(control);
    controlsByGroup.set(key, controls);
  }

  const groups = groupOrder
    .filter((key) => controlsByGroup.has(key))
    .map((key) =>
      group({
        id: key === DEFAULT_GROUP_KEY ? DEFAULT_GROUP.id : key,
        label: key === DEFAULT_GROUP_KEY ? DEFAULT_GROUP.label : key,
        controls: controlsByGroup.get(key) ?? []
      })
    );

  return { id: SCENES_SCHEMA_ID, title: "Scenes", groups };
}

/** "product-reveal" -> "Product reveal", "likeBurst" -> "Like burst". */
function deriveSceneTitle(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  const joined = words.join(" ");
  if (!joined) return id;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** The scheme an Expo development build declares (`expo.scheme`); not used inside Expo Go. */
function getExpoAppScheme(): string | undefined {
  try {
    const constants = (globalThis as {
      expo?: { modules?: { ExponentConstants?: { appOwnership?: unknown; manifest?: unknown } } };
    }).expo?.modules?.ExponentConstants;
    if (!constants || constants.appOwnership === "expo") return undefined;
    const raw = constants.manifest;
    const manifest = (typeof raw === "string" ? JSON.parse(raw) : raw) as
      | { scheme?: unknown; extra?: { expoClient?: { scheme?: unknown } } }
      | undefined;
    const declared = manifest?.extra?.expoClient?.scheme ?? manifest?.scheme;
    const scheme = Array.isArray(declared) ? declared[0] : declared;
    return typeof scheme === "string" && /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? scheme : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Expo Go's deep-link base: the experience url when it carries a host (it can be a bare
 * "exp://"), otherwise, inside Expo Go, `exp://<host:port>` of the Metro script url that
 * broker discovery resolves.
 */
function getExpoGoBaseUrl(): string | undefined {
  let constants: { experienceUrl?: unknown; appOwnership?: unknown } | undefined;
  try {
    constants = (globalThis as {
      expo?: { modules?: { ExponentConstants?: { experienceUrl?: unknown; appOwnership?: unknown } } };
    }).expo?.modules?.ExponentConstants;
  } catch {
    return undefined;
  }
  if (!constants) return undefined;

  const experienceUrl = constants.experienceUrl;
  if (typeof experienceUrl === "string" && urlAuthority(experienceUrl)) {
    return experienceUrl.replace(/\/+$/, "");
  }

  if (constants.appOwnership !== "expo") return undefined;
  let scriptUrl: string | undefined;
  try {
    scriptUrl = __resolveDevServerScriptUrl();
  } catch {
    return undefined;
  }
  const authority = scriptUrl ? urlAuthority(scriptUrl) : undefined;
  return authority ? `exp://${authority}` : undefined;
}

/** "http://127.0.0.1:8090/index.bundle?x" -> "127.0.0.1:8090"; undefined without a host. */
function urlAuthority(url: string): string | undefined {
  const match = url.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/([^/?#]+)/);
  return match?.[1];
}

function isValidSceneId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function requestFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 16);
}

function warnDev(message: string) {
  if (isDev()) {
    console.warn(`[Runtime Inspector] ${message}`);
  }
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}

function noop() {}
