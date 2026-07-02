import {
  RIP_VERSION,
  safeParseRIPMessage,
  validateControlValue,
  type BatchPatch,
  type BezierControl,
  type ColorControl,
  type ControlCommit,
  type ControlGroup,
  type ControlPatch,
  type ControlTrigger,
  type CubicBezier,
  type InspectorControl,
  type PanelSchema,
  type SliderControl,
  type SpringControl,
  type SpringValue,
  type ToggleControl,
  type TriggerControl,
  isValueControl
} from "@runtime-inspector/protocol";
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";
import { getBrokerCandidates, resolveScriptUrl } from "./discovery";

declare const __DEV__: boolean | undefined;

export interface RuntimeInspectorOptions {
  brokerUrl?: string;
  clientId?: string;
  clientName?: string;
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface SharedValueLike<T> {
  value: T;
}

type BindingTarget = SharedValueLike<unknown> | ((value: unknown) => void);
type TriggerHandler = () => void;

const bindingRegistry = new Map<string, BindingTarget>();
const triggerRegistry = new Map<string, TriggerHandler>();

interface Session {
  schema: PanelSchema;
  options: RuntimeInspectorOptions;
  socket: WebSocket | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  shouldReconnect: boolean;
  candidateIndex: number;
  lockedUrl: string | undefined;
  warnedTunnel: boolean;
  warnedFullCycle: boolean;
}

const sessions = new Map<string, Session>();

function getScriptUrl(): Array<string | undefined> {
  let fromNativeModules: string | undefined;
  try {
    fromNativeModules =
      NativeModules?.SourceCode?.getConstants?.().scriptURL ??
      NativeModules?.SourceCode?.scriptURL;
  } catch {
    // try the next source
  }

  let fromTurboModule: string | undefined;
  try {
    const sourceCode = TurboModuleRegistry?.get?.("SourceCode") as
      | { getConstants?: () => { scriptURL?: string } }
      | null
      | undefined;
    fromTurboModule = sourceCode?.getConstants?.().scriptURL;
  } catch {
    // try the next source
  }

  let fromExpoGlobal: string | undefined;
  try {
    const expoGlobal = (globalThis as {
      expo?: { modules?: { ExponentConstants?: { experienceUrl?: string } } };
    }).expo;
    fromExpoGlobal = expoGlobal?.modules?.ExponentConstants?.experienceUrl;
  } catch {
    // no more sources
  }

  return [fromNativeModules, fromTurboModule, fromExpoGlobal];
}

function getPlatformOs(): string | undefined {
  try {
    return Platform?.OS;
  } catch {
    return undefined;
  }
}

export function slider(config: Omit<SliderControl, "kind">): SliderControl {
  return { ...config, kind: "slider" };
}

export function toggle(config: Omit<ToggleControl, "kind">): ToggleControl {
  return { ...config, kind: "toggle" };
}

export function color(config: Omit<ColorControl, "kind">): ColorControl {
  return { ...config, kind: "color" };
}

export function bezier(config: Omit<BezierControl, "kind">): BezierControl {
  return { ...config, kind: "bezier" };
}

export function spring(config: Omit<SpringControl, "kind">): SpringControl {
  return { ...config, kind: "spring" };
}

export function trigger(config: Omit<TriggerControl, "kind">): TriggerControl {
  return { ...config, kind: "trigger" };
}

export function group(config: {
  id: string;
  label: string;
  description?: string;
  controls: InspectorControl[];
}): ControlGroup {
  return config;
}

export function definePanel(schema: PanelSchema, options: RuntimeInspectorOptions = {}) {
  const existing = sessions.get(schema.id);
  if (existing) {
    teardownSession(existing);
  }

  for (const controlGroup of schema.groups) {
    for (const control of controlGroup.controls) {
      if (control.kind !== "trigger" && control.binding && control.value === undefined) {
        control.value = control.defaultValue as never;
      }
    }
  }

  if (!isDev()) {
    return { schema, connect: noop, disconnect: noop };
  }

  const session: Session = {
    schema,
    options,
    socket: undefined,
    reconnectTimer: undefined,
    shouldReconnect: false,
    candidateIndex: 0,
    lockedUrl: undefined,
    warnedTunnel: false,
    warnedFullCycle: false
  };
  sessions.set(schema.id, session);

  return {
    schema,
    connect: () => connectRuntime(session),
    disconnect: () => disconnectRuntime(session)
  };
}

export function bindSharedValue<T>(
  binding: string,
  sharedValue: SharedValueLike<T>
): SharedValueLike<T> {
  bindingRegistry.set(binding, sharedValue as SharedValueLike<unknown>);
  return sharedValue;
}

export function bindValue(binding: string, setter: (value: unknown) => void) {
  bindingRegistry.set(binding, setter);
}

export function bindTrigger(binding: string, handler: TriggerHandler) {
  triggerRegistry.set(binding, handler);
}

export function applyControlTrigger(trigger: ControlTrigger) {
  const session = sessions.get(trigger.schemaId);
  if (!session) return;

  const control = findControl(session.schema, trigger.controlId);
  if (!control) return;

  if (control.kind !== "trigger") {
    warnDev(
      `Ignoring control.trigger for non-trigger control "${control.id}".`
    );
    return;
  }

  const bindingId = control.binding ?? control.id;
  triggerRegistry.get(bindingId)?.();
}

export function applyControlPatch(patch: ControlPatch) {
  const session = sessions.get(patch.schemaId);
  if (!session) return;

  const control = findControl(session.schema, patch.controlId);
  if (!control) return;

  if (control.kind === "trigger") {
    warnDev(
      `Ignoring control.patch targeting trigger control "${control.id}" - use control.trigger instead.`
    );
    return;
  }

  if (!isValueControl(control)) return;
  const validation = validateControlValue(control, patch.value);
  if (!validation.ok) {
    warnDev(
      `Ignoring invalid value for ${control.kind} control "${control.id}" (${validation.code}): ${validation.message}`
    );
    return;
  }

  control.value = patch.value as never;
  const bindingId = control.binding ?? control.id;
  const target = bindingRegistry.get(bindingId);

  if (!target) return;
  if (typeof target === "function") {
    target(patch.value);
  } else {
    target.value = patch.value;
  }
}

export function applyControlCommit(commit: ControlCommit) {
  applyControlPatch({
    type: "control.patch",
    schemaId: commit.schemaId,
    controlId: commit.controlId,
    value: commit.value,
    source: commit.source,
    timestamp: commit.timestamp
  });
}

export function applyBatchPatch(batch: BatchPatch) {
  for (const patch of batch.patches) {
    applyControlPatch({
      type: "control.patch",
      schemaId: batch.schemaId,
      source: patch.source ?? batch.source,
      timestamp: patch.timestamp ?? batch.timestamp,
      controlId: patch.controlId,
      value: patch.value
    });
  }
}

export type { CubicBezier, PanelSchema, SpringValue };

export { useInspector, buildInspector, deriveLabel } from "./use-inspector";
export type {
  InspectorSpec,
  InspectorSpecEntry,
  InspectorHandles,
  SliderSpecEntry,
  SpringSpecEntry
} from "./use-inspector";

function connectRuntime(session: Session) {
  if (
    session.socket?.readyState === WebSocket.OPEN ||
    session.socket?.readyState === WebSocket.CONNECTING
  ) {
    return;
  }

  const { schema, options } = session;
  session.shouldReconnect = options.reconnect ?? true;
  const { scriptUrl, tunnelUrl } = resolveScriptUrl(getScriptUrl());
  const candidates = options.brokerUrl
    ? [options.brokerUrl]
    : getBrokerCandidates({
        scriptUrl,
        platform: getPlatformOs(),
        defaultPort: 4577
      });

  if (tunnelUrl && !scriptUrl && !session.warnedTunnel) {
    session.warnedTunnel = true;
    warnDev(
      `Dev server is behind a tunnel (${tunnelUrl}). A tunnel cannot reach a local broker - use LAN mode or set EXPO_PUBLIC_RI_BROKER_URL.`
    );
  }

  if (
    !session.lockedUrl &&
    !session.warnedFullCycle &&
    session.candidateIndex > 0 &&
    session.candidateIndex % candidates.length === 0
  ) {
    session.warnedFullCycle = true;
    warnDev(
      `Could not reach a Runtime Inspector broker at: ${candidates.join(", ")}. Is \`runtime-inspector dev\` running? Set EXPO_PUBLIC_RI_BROKER_URL or pass brokerUrl to override.`
    );
  }

  const brokerUrl = session.lockedUrl ?? candidates[session.candidateIndex % candidates.length];
  if (session.candidateIndex === 0 && !session.lockedUrl) {
    warnDev(
      `Discovery: scriptUrl=${scriptUrl ?? "undefined"} tunnelUrl=${tunnelUrl ?? "undefined"} platform=${getPlatformOs() ?? "undefined"} candidates=${candidates.join(", ")}`
    );
  }
  warnDev(`Connecting to ${brokerUrl}`);
  const clientId = options.clientId ?? `runtime-${schema.id}`;
  const socket = new WebSocket(brokerUrl);
  session.socket = socket;
  let didOpen = false;

  socket.onopen = () => {
    didOpen = true;
    session.lockedUrl = brokerUrl;
    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: RIP_VERSION,
        role: "runtime",
        clientId,
        clientName: options.clientName ?? "React Native Runtime"
      })
    );
    socket.send(JSON.stringify({ type: "schema.publish", schema }));
  };

  socket.onmessage = (event) => {
    const message = parseRuntimeMessage(event.data);
    if (!message) return;

    if (message.type === "control.patch") {
      applyControlPatch(message);
    }
    if (message.type === "control.batchPatch") {
      applyBatchPatch(message);
    }
    if (message.type === "control.trigger") {
      applyControlTrigger(message);
    }
    if (message.type === "control.commit") {
      applyControlCommit(message);
    }
  };

  socket.onclose = () => {
    session.socket = undefined;
    if (!didOpen && !session.lockedUrl) {
      session.candidateIndex += 1;
    }
    scheduleReconnect(session);
  };

  socket.onerror = () => {
    socket.close();
  };
}

function parseRuntimeMessage(data: unknown) {
  const message = safeParseRIPMessage(data);
  if (!message) {
    warnDev("Ignoring invalid protocol message");
  }
  return message;
}

function sendSchemaDispose(session: Session) {
  const socket = session.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(
      JSON.stringify({
        type: "schema.dispose",
        schemaId: session.schema.id,
        source: "runtime"
      })
    );
  } catch {
    // best-effort: disposal is not guaranteed delivery
  }
}

function disconnectRuntime(session: Session) {
  session.shouldReconnect = false;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }
  sendSchemaDispose(session);
  session.socket?.close();
  session.socket = undefined;
  session.candidateIndex = 0;
  session.lockedUrl = undefined;
}

function teardownSession(session: Session) {
  session.shouldReconnect = false;
  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = undefined;
  }
  sendSchemaDispose(session);
  session.socket?.close();
  session.socket = undefined;
}

function scheduleReconnect(session: Session) {
  if (!session.shouldReconnect || session.reconnectTimer) return;

  const { options } = session;
  const delay = session.lockedUrl
    ? options.reconnectDelayMs ?? 1000
    : Math.min(options.reconnectDelayMs ?? 1000, 250);

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = undefined;
    connectRuntime(session);
  }, delay);
}

function findControl(schema: PanelSchema, controlId: string): InspectorControl | undefined {
  for (const controlGroup of schema.groups) {
    const control = controlGroup.controls.find((item) => item.id === controlId);
    if (control) return control;
  }
  return undefined;
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
