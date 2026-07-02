import {
  RIP_VERSION,
  createPatch,
  isValidControlValue,
  isValueControl,
  safeParseRIPMessage,
  type CubicBezier,
  type InspectorControl,
  type PanelSchema,
  type SpringValue,
  type TriggerControl
} from "@runtime-inspector/protocol";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "rejected";

export type CompareSlotId = "A" | "B";

export interface LastPatchInfo {
  controlId: string;
  label: string;
  at: string;
}

export interface PanelState {
  status: ConnectionStatus;
  notice?: string;
  schemas: PanelSchema[];
  values: Record<string, Record<string, unknown>>;
  lastPatch?: LastPatchInfo;
  compareSlots: Partial<Record<CompareSlotId, Record<string, unknown>>>;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export const WEBSOCKET_OPEN = 1;

export interface CreatePanelSessionOptions {
  url: string;
  token?: string;
  clientId?: string;
  sliderThrottleMs?: number;
  createSocket?: (url: string) => WebSocketLike;
  now?: () => number;
}

type PendingPatch = {
  controlId: string;
  value: unknown;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSentAt: number;
};

export interface PanelSession {
  getState(): PanelState;
  subscribe(listener: () => void): () => void;
  connect(): void;
  dispose(): void;
  setValue(schemaId: string, controlId: string, value: unknown): void;
  commitValue(schemaId: string, controlId: string): void;
  fireTrigger(schemaId: string, controlId: string): void;
  saveCompareSlot(slot: CompareSlotId, schemaId: string): void;
  applyCompareSlot(slot: CompareSlotId, schemaId: string): void;
  exportTypeScript(schemaId: string): string;
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

export function createPanelSession(options: CreatePanelSessionOptions): PanelSession {
  const {
    url,
    token,
    clientId = "panel-web",
    sliderThrottleMs = 50,
    createSocket = defaultCreateSocket,
    now = () => performance.now()
  } = options;

  let state: PanelState = {
    status: "connecting",
    notice: undefined,
    schemas: [],
    values: {},
    lastPatch: undefined,
    compareSlots: {}
  };

  const listeners = new Set<() => void>();
  const schemasById = new Map<string, PanelSchema>();
  const pendingPatches = new Map<string, PendingPatch>();

  let socket: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let stopReconnecting = false;

  function setState(patch: Partial<PanelState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener();
    }
  }

  function getState() {
    return state;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function connectSocket() {
    setState({ status: "connecting" });
    const nextSocket = createSocket(url);
    socket = nextSocket;

    nextSocket.onopen = () => {
      setState({ status: "connected", notice: undefined });
      nextSocket.send(
        JSON.stringify({
          type: "handshake.hello",
          protocolVersion: RIP_VERSION,
          role: "panel",
          clientId,
          clientName: "Runtime Inspector Web Panel",
          token
        })
      );
    };

    nextSocket.onclose = () => {
      if (socket === nextSocket) {
        socket = null;
      }
      setState({
        status: stopReconnecting ? "rejected" : "disconnected",
        notice: stopReconnecting ? state.notice : "Broker disconnected. Reconnecting..."
      });
      if (!disposed && !stopReconnecting) {
        reconnectTimer = setTimeout(connectSocket, 1000);
      }
    };

    nextSocket.onerror = () => {
      setState({ notice: "WebSocket connection error." });
      nextSocket.close();
    };

    nextSocket.onmessage = (event) => {
      const message = safeParseRIPMessage(event.data);
      if (!message) {
        setState({ notice: "Ignored invalid protocol message from broker." });
        return;
      }

      if (message.type === "schema.publish") {
        schemasById.set(message.schema.id, message.schema);
        setState({
          schemas: Array.from(schemasById.values()),
          values: {
            ...state.values,
            [message.schema.id]: collectInitialValues(message.schema)
          },
          notice: undefined
        });
      }
      if (message.type === "control.patch") {
        const schemaValues = state.values[message.schemaId] ?? {};
        setState({
          values: {
            ...state.values,
            [message.schemaId]: { ...schemaValues, [message.controlId]: message.value }
          }
        });
      }
      if (message.type === "control.batchPatch") {
        const schemaValues = state.values[message.schemaId] ?? {};
        setState({
          values: {
            ...state.values,
            [message.schemaId]: {
              ...schemaValues,
              ...Object.fromEntries(message.patches.map((patch) => [patch.controlId, patch.value]))
            }
          }
        });
      }
      if (message.type === "error" && message.code === "UNAUTHORIZED") {
        stopReconnecting = true;
        setState({ status: "rejected", notice: "Broker rejected this panel: missing or wrong token." });
        nextSocket.close();
      }
    };
  }

  function connect() {
    disposed = false;
    stopReconnecting = false;
    connectSocket();
  }

  function dispose() {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    clearPendingPatches();
    socket?.close();
  }

  function clearPendingPatches() {
    for (const pending of pendingPatches.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    pendingPatches.clear();
  }

  function send(message: unknown) {
    if (socket && socket.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function sendPatch(schemaId: string, controlId: string, value: unknown) {
    send(createPatch(schemaId, controlId, value));
  }

  function sendBatchPatch(schemaId: string, snapshot: Record<string, unknown>) {
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    send({
      type: "control.batchPatch",
      schemaId,
      source: "preset",
      timestamp: Date.now(),
      patches: Object.entries(snapshot).map(([controlId, value]) => ({ controlId, value }))
    });
  }

  function findControl(schemaId: string, controlId: string): InspectorControl | undefined {
    const schema = schemasById.get(schemaId);
    if (!schema) return undefined;
    for (const group of schema.groups) {
      const found = group.controls.find((control) => control.id === controlId);
      if (found) return found;
    }
    return undefined;
  }

  function markPatch(controlId: string, label: string) {
    setState({
      lastPatch: {
        controlId,
        label,
        at: formatTime(new Date())
      }
    });
  }

  function setValue(schemaId: string, controlId: string, value: unknown) {
    const control = findControl(schemaId, controlId);
    if (!control) return;

    if (!isValidControlValue(control, value)) {
      setState({ notice: `Invalid value for ${control.label}.` });
      return;
    }

    if (isValueControl(control)) {
      const schemaValues = state.values[schemaId] ?? {};
      setState({
        values: {
          ...state.values,
          [schemaId]: { ...schemaValues, [controlId]: value }
        }
      });
    }

    if (control.kind === "slider") {
      sendPatchThrottled(schemaId, controlId, value);
    } else {
      sendPatch(schemaId, controlId, value);
    }

    markPatch(control.id, control.label);
  }

  function sendPatchThrottled(schemaId: string, controlId: string, value: unknown) {
    const existing = pendingPatches.get(controlId);
    const currentTime = now();

    if (!existing || currentTime - existing.lastSentAt >= sliderThrottleMs) {
      if (existing?.timer) {
        clearTimeout(existing.timer);
      }
      sendPatch(schemaId, controlId, value);
      pendingPatches.set(controlId, {
        controlId,
        value,
        timer: undefined,
        lastSentAt: currentTime
      });
      return;
    }

    if (existing.timer) {
      clearTimeout(existing.timer);
    }

    existing.value = value;
    existing.timer = setTimeout(() => {
      sendPatch(schemaId, controlId, existing.value);
      pendingPatches.set(controlId, {
        controlId,
        value: existing.value,
        timer: undefined,
        lastSentAt: now()
      });
    }, sliderThrottleMs - (currentTime - existing.lastSentAt));
  }

  function commitValue(schemaId: string, controlId: string) {
    const pending = pendingPatches.get(controlId);
    if (!pending) return;

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    sendPatch(schemaId, controlId, pending.value);
    pendingPatches.delete(controlId);
  }

  function fireTrigger(schemaId: string, controlId: string) {
    setValue(schemaId, controlId, Date.now());
  }

  function saveCompareSlot(slot: CompareSlotId, schemaId: string) {
    const values = state.values[schemaId] ?? {};
    setState({
      compareSlots: {
        ...state.compareSlots,
        [slot]: structuredClone(values)
      }
    });
  }

  function applyCompareSlot(slot: CompareSlotId, schemaId: string) {
    const snapshot = state.compareSlots[slot];
    const schema = schemasById.get(schemaId);
    if (!schema || !snapshot) return;

    const validSnapshot = filterValidSnapshot(schema, snapshot);
    setState({
      values: {
        ...state.values,
        [schemaId]: validSnapshot
      }
    });
    sendBatchPatch(schemaId, validSnapshot);

    const replayTrigger = findReplayTrigger(schema);
    if (replayTrigger) {
      setTimeout(() => {
        sendPatch(schemaId, replayTrigger.id, Date.now());
      }, 80);
    }

    markPatch(`compare-${slot}`, `Applied ${slot}`);
  }

  function exportTypeScript(schemaId: string): string {
    const schema = schemasById.get(schemaId);
    if (!schema) return "";
    const values = state.values[schemaId] ?? {};
    return createTypeScriptPreset(schema, values);
  }

  return {
    getState,
    subscribe,
    connect,
    dispose,
    setValue,
    commitValue,
    fireTrigger,
    saveCompareSlot,
    applyCompareSlot,
    exportTypeScript
  };
}

function filterValidSnapshot(schema: PanelSchema, snapshot: Record<string, unknown>) {
  const controlsById = new Map<string, InspectorControl>(
    schema.groups.flatMap((group) => group.controls.map((control) => [control.id, control] as const))
  );

  return Object.fromEntries(
    Object.entries(snapshot).filter(([controlId, value]) => {
      const control = controlsById.get(controlId);
      return control ? isValidControlValue(control, value) : false;
    })
  );
}

function findReplayTrigger(schema: PanelSchema) {
  return schema.groups
    .flatMap((controlGroup) => controlGroup.controls)
    .find(
      (control): control is TriggerControl =>
        control.kind === "trigger" &&
        (control.id.toLowerCase().includes("replay") ||
          Boolean(control.binding?.toLowerCase().includes("replay")))
    );
}

function collectInitialValues(schema: PanelSchema) {
  return Object.fromEntries(
    schema.groups.flatMap((controlGroup) =>
      controlGroup.controls
        .filter(isValueControl)
        .map((control) => [control.id, control.value ?? control.defaultValue])
    )
  );
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function createTypeScriptPreset(schema: PanelSchema, values: Record<string, unknown>) {
  const variableName = toCamelCase(`${schema.id}Preset`);
  const lines = [`export const ${variableName} = ${JSON.stringify(values, null, 2)} as const;`];

  const spring = coerceOptionalSpringValue(values.spring);
  if (spring) {
    lines.push(
      "",
      `export const ${variableName}Spring = ${JSON.stringify(spring, null, 2)} as const;`,
      `// withSpring(targetValue, ${variableName}Spring)`
    );
  }

  const easing = coerceOptionalBezierValue(values.easing);
  if (easing) {
    lines.push(
      "",
      `export const ${variableName}Easing = Easing.bezier(${easing
        .map((part) => formatNumber(part))
        .join(", ")});`
    );
  }

  if (spring || easing) {
    lines.push("", `// import { Easing, withSpring } from "react-native-reanimated";`);
  }

  return lines.join("\n");
}

export function coerceOptionalSpringValue(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SpringValue>;
  if (typeof candidate.damping !== "number") return undefined;
  if (typeof candidate.stiffness !== "number") return undefined;
  return {
    damping: candidate.damping,
    stiffness: candidate.stiffness,
    ...(typeof candidate.mass === "number" ? { mass: candidate.mass } : {})
  };
}

export function coerceOptionalBezierValue(value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((part) => typeof part === "number")) return undefined;
  return value as CubicBezier;
}

function toCamelCase(input: string) {
  const parts = input
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/);

  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}
