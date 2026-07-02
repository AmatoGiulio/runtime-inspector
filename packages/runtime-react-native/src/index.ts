import {
  RIP_VERSION,
  parseRIPMessage,
  type BatchPatch,
  type BezierControl,
  type ColorControl,
  type ControlGroup,
  type ControlPatch,
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
let socket: WebSocket | undefined;
let activeSchema: PanelSchema | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let shouldReconnect = false;

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
  activeSchema = schema;

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

  return {
    schema,
    connect: () => connectRuntime(schema, options),
    disconnect: () => disconnectRuntime()
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

export function applyControlPatch(patch: ControlPatch) {
  if (!activeSchema || patch.schemaId !== activeSchema.id) return;

  const control = findControl(activeSchema, patch.controlId);
  if (!control) return;

  if (control.kind === "trigger") {
    const bindingId = control.binding ?? control.id;
    triggerRegistry.get(bindingId)?.();
    return;
  }

  if (!isValueControl(control)) return;
  if (!isPatchValueValid(control, patch.value)) {
    warnDev(
      `Ignoring invalid value for ${control.kind} control "${control.id}".`
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

function connectRuntime(schema: PanelSchema, options: RuntimeInspectorOptions) {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  shouldReconnect = options.reconnect ?? true;
  const brokerUrl = options.brokerUrl ?? "ws://127.0.0.1:4577";
  const clientId = options.clientId ?? `runtime-${schema.id}`;
  socket = new WebSocket(brokerUrl);

  socket.onopen = () => {
    socket?.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: RIP_VERSION,
        role: "runtime",
        clientId,
        clientName: options.clientName ?? "React Native Runtime"
      })
    );
    socket?.send(JSON.stringify({ type: "schema.publish", schema }));
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
  };

  socket.onclose = () => {
    socket = undefined;
    scheduleReconnect(schema, options);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

function parseRuntimeMessage(data: unknown) {
  try {
    const raw = typeof data === "string" ? data : String(data);
    return parseRIPMessage(JSON.parse(raw));
  } catch (error) {
    if (isDev()) {
      console.warn(
        "[Runtime Inspector] Ignoring invalid protocol message",
        error instanceof Error ? error.message : error
      );
    }
    return undefined;
  }
}

function disconnectRuntime() {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  socket?.close();
  socket = undefined;
}

function scheduleReconnect(schema: PanelSchema, options: RuntimeInspectorOptions) {
  if (!shouldReconnect || reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectRuntime(schema, options);
  }, options.reconnectDelayMs ?? 1000);
}

function findControl(schema: PanelSchema, controlId: string): InspectorControl | undefined {
  for (const controlGroup of schema.groups) {
    const control = controlGroup.controls.find((item) => item.id === controlId);
    if (control) return control;
  }
  return undefined;
}

function isPatchValueValid(control: InspectorControl, value: unknown) {
  switch (control.kind) {
    case "slider":
      return typeof value === "number" && Number.isFinite(value);
    case "toggle":
      return typeof value === "boolean";
    case "color":
      return typeof value === "string";
    case "bezier":
      return (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((part) => typeof part === "number" && Number.isFinite(part))
      );
    case "spring":
      return isSpringPatchValue(value);
    case "trigger":
      return true;
    default:
      return false;
  }
}

function isSpringPatchValue(value: unknown) {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<SpringValue>;
  return (
    typeof candidate.damping === "number" &&
    Number.isFinite(candidate.damping) &&
    typeof candidate.stiffness === "number" &&
    Number.isFinite(candidate.stiffness) &&
    (candidate.mass === undefined ||
      (typeof candidate.mass === "number" && Number.isFinite(candidate.mass)))
  );
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
