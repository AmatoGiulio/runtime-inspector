import {
  RIP_VERSION,
  createCommit,
  createPatch,
  createTrigger,
  isValidControlValue,
  isValueControl,
  safeParseRIPMessage,
  validateControlValue,
  type CubicBezier,
  type InspectorControl,
  type PanelSchema,
  type SourceApplyRequest,
  type SourceApplyResult,
  type SourceApplyResultEntry,
  type RecordingSample,
  type RuntimeProbeDescriptor,
  type SpringValue,
  type TraceSchemaPublish,
  type TriggerControl
} from "@runtime-inspector/protocol";

export { sampleSpringCurve, type SpringCurve } from "./spring-curve";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "rejected";

export type CompareSlotId = "A" | "B";

export interface LastPatchInfo {
  controlId: string;
  label: string;
  at: string;
}

export interface LastApplyResultInfo {
  schemaId: string;
  results: SourceApplyResultEntry[];
  at: string;
}

export interface RecordingTraceState {
  id: string;
  schemaId: string;
  probeIds: string[];
  sampleRateHz: number;
  startedAtRuntimeMs?: number;
  samples: RecordingSample[];
  nextSequence: number;
  complete: boolean;
  incomplete: boolean;
  durationMs?: number;
  sampleCount?: number;
}

export interface PanelState {
  status: ConnectionStatus;
  notice?: string;
  schemas: PanelSchema[];
  /**
   * Per-schema staleness: true when the publishing runtime has disconnected
   * without disposing the schema (e.g. mid Metro-reload). The schema and its
   * last-known values remain visible, but outgoing patches/commits/triggers
   * are blocked until the runtime republishes.
   */
  staleSchemaIds: Record<string, boolean>;
  values: Record<string, Record<string, unknown>>;
  traceSchemas: Record<string, RuntimeProbeDescriptor[]>;
  recording?: RecordingTraceState;
  lastPatch?: LastPatchInfo;
  /** Results of the most recently received `source.applyResult`, keyed by nothing (single latest snapshot). */
  lastApplyResult?: LastApplyResultInfo;
  compareSlots: Record<string, Partial<Record<CompareSlotId, Record<string, unknown>>>>;
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
  schemaId: string;
  controlId: string;
  value: unknown;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSentAt: number;
};

function pendingKey(schemaId: string, controlId: string): string {
  return `${schemaId}:${controlId}`;
}

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
  applySource(schemaId: string, controlIds?: string[]): void;
  startRecording(schemaId: string, probeIds: string[], sampleRateHz?: number): string | undefined;
  stopRecording(): void;
  clearRecording(): void;
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
    staleSchemaIds: {},
    values: {},
    traceSchemas: {},
    recording: undefined,
    lastPatch: undefined,
    compareSlots: {}
  };

  const listeners = new Set<() => void>();
  const schemasById = new Map<string, PanelSchema>();
  const pendingPatches = new Map<string, PendingPatch>();
  let recordingCounter = 0;

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
          staleSchemaIds: { ...state.staleSchemaIds, [message.schema.id]: false },
          notice: undefined
        });
      }
      if (message.type === "schema.dispose") {
        schemasById.delete(message.schemaId);
        clearPendingPatchesForSchema(message.schemaId);
        const { [message.schemaId]: _removedStale, ...restStale } = state.staleSchemaIds;
        const { [message.schemaId]: _removedValues, ...restValues } = state.values;
        const { [message.schemaId]: _removedTrace, ...restTrace } = state.traceSchemas;
        setState({
          schemas: Array.from(schemasById.values()),
          staleSchemaIds: restStale,
          values: restValues,
          traceSchemas: restTrace
        });
      }
      if (message.type === "runtime.status") {
        if (message.schemaId) {
          if (schemasById.has(message.schemaId)) {
            setState({
              staleSchemaIds: { ...state.staleSchemaIds, [message.schemaId]: !message.online }
            });
          }
        }
      }
      if (message.type === "trace.schema.publish") {
        applyTraceSchema(message);
      }
      if (message.type === "trace.schema.dispose") {
        const { [message.schemaId]: _removedTrace, ...restTrace } = state.traceSchemas;
        setState({ traceSchemas: restTrace });
      }
      if (message.type === "recording.started") {
        if (state.recording?.id === message.recordingId) {
          setState({
            recording: {
              ...state.recording,
              startedAtRuntimeMs: message.startedAtRuntimeMs,
              sampleRateHz: message.sampleRateHz
            }
          });
        }
      }
      if (message.type === "recording.chunk") {
        applyRecordingChunk(message);
      }
      if (message.type === "recording.complete") {
        if (state.recording?.id === message.recordingId) {
          setState({
            recording: {
              ...state.recording,
              complete: true,
              durationMs: message.durationMs,
              sampleCount: message.sampleCount
            }
          });
        }
      }
      if (message.type === "control.patch") {
        applyIncomingValue(message.schemaId, message.controlId, message.value);
      }
      if (message.type === "control.commit") {
        applyIncomingValue(message.schemaId, message.controlId, message.value);
      }
      if (message.type === "control.batchPatch") {
        applyIncomingBatch(
          message.schemaId,
          Object.fromEntries(message.patches.map((patch) => [patch.controlId, patch.value]))
        );
      }
      if (message.type === "source.applyResult") {
        applySourceResult(message);
      }
      if (
        message.type === "error" &&
        (message.code === "TRACE_SCHEMA_MISSING" ||
          message.code === "UNKNOWN_PROBE" ||
          message.code === "RECORDING_ACTIVE")
      ) {
        setState({
          notice: message.message,
          ...(state.recording && !state.recording.complete
            ? {
                recording: {
                  ...state.recording,
                  complete: true,
                  incomplete: true
                }
              }
            : {})
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

  function clearPendingPatchesForSchema(schemaId: string) {
    for (const [key, pending] of pendingPatches.entries()) {
      if (pending.schemaId !== schemaId) continue;
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pendingPatches.delete(key);
    }
  }

  function send(message: unknown) {
    if (socket && socket.readyState === WEBSOCKET_OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function isStale(schemaId: string): boolean {
    return Boolean(state.staleSchemaIds[schemaId]);
  }

  function blockIfStale(schemaId: string): boolean {
    if (!isStale(schemaId)) return false;
    setState({ notice: "Runtime disconnected - controls are frozen." });
    return true;
  }

  function sendPatch(schemaId: string, controlId: string, value: unknown) {
    send(createPatch(schemaId, controlId, value));
  }

  function sendCommit(schemaId: string, controlId: string, value: unknown) {
    send(createCommit(schemaId, controlId, value));
  }

  function sendTrigger(schemaId: string, controlId: string) {
    send(createTrigger(schemaId, controlId));
  }

  function sendBatchPatch(schemaId: string, snapshot: Record<string, unknown>, committed = false) {
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
    send({
      type: "control.batchPatch",
      schemaId,
      source: "preset",
      timestamp: Date.now(),
      patches: Object.entries(snapshot).map(([controlId, value]) => ({ controlId, value })),
      committed
    });
  }

  function findControl(schemaId: string, controlId: string): InspectorControl | undefined {
    const schema = schemasById.get(schemaId);
    if (!schema) return undefined;
    return findControlInSchema(schema, controlId);
  }

  function validateIncomingValue(schemaId: string, controlId: string, value: unknown) {
    const control = findControl(schemaId, controlId);
    if (!control) return undefined;
    const validation = validateControlValue(control, value);
    if (!validation.ok) {
      setState({ notice: `Ignored invalid incoming value for ${control.label}: ${validation.message}` });
      return undefined;
    }
    return control;
  }

  function applyIncomingValue(schemaId: string, controlId: string, value: unknown) {
    const control = validateIncomingValue(schemaId, controlId, value);
    if (!control || !isValueControl(control)) return;

    const schemaValues = state.values[schemaId] ?? {};
    setState({
      values: {
        ...state.values,
        [schemaId]: { ...schemaValues, [controlId]: value }
      }
    });
  }

  function applyIncomingBatch(schemaId: string, snapshot: Record<string, unknown>) {
    const schema = schemasById.get(schemaId);
    if (!schema) return;

    const controlsById = controlsByIdForSchema(schema);
    const nextValues: Record<string, unknown> = {};

    for (const [controlId, value] of Object.entries(snapshot)) {
      const control = controlsById.get(controlId);
      if (!control || !isValueControl(control)) continue;
      const validation = validateControlValue(control, value);
      if (!validation.ok) {
        setState({ notice: `Ignored invalid incoming batch value for ${control.label}: ${validation.message}` });
        return;
      }
      nextValues[controlId] = value;
    }

    const schemaValues = state.values[schemaId] ?? {};
    setState({
      values: {
        ...state.values,
        [schemaId]: {
          ...schemaValues,
          ...nextValues
        }
      }
    });
  }

  function applyTraceSchema(message: TraceSchemaPublish) {
    setState({
      traceSchemas: {
        ...state.traceSchemas,
        [message.schemaId]: message.probes
      }
    });
  }

  function applyRecordingChunk(message: {
    recordingId: string;
    sequence: number;
    samples: RecordingSample[];
  }) {
    const recording = state.recording;
    if (!recording || recording.id !== message.recordingId) return;
    const sequenceGap = message.sequence !== recording.nextSequence;
    setState({
      recording: {
        ...recording,
        samples: [...recording.samples, ...message.samples],
        nextSequence: message.sequence + 1,
        incomplete: recording.incomplete || sequenceGap
      }
    });
  }

  function applySourceResult(message: SourceApplyResult) {
    const expressionMismatch = message.results.find(
      (entry): entry is Extract<SourceApplyResultEntry, { ok: false }> =>
        !entry.ok && entry.code === "EXPRESSION_MISMATCH"
    );

    setState({
      lastApplyResult: {
        schemaId: message.schemaId,
        results: message.results,
        at: formatTime(new Date())
      },
      ...(expressionMismatch
        ? { notice: "file changed since launch — hot-reload and retry" }
        : {})
    });
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
    if (blockIfStale(schemaId)) return;

    const control = findControl(schemaId, controlId);
    if (!control) return;

    const validation = validateControlValue(control, value);
    if (!validation.ok) {
      setState({ notice: `Invalid value for ${control.label}: ${validation.message}` });
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
    const key = pendingKey(schemaId, controlId);
    const existing = pendingPatches.get(key);
    const currentTime = now();

    if (!existing || currentTime - existing.lastSentAt >= sliderThrottleMs) {
      if (existing?.timer) {
        clearTimeout(existing.timer);
      }
      sendPatch(schemaId, controlId, value);
      pendingPatches.set(key, {
        schemaId,
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
      pendingPatches.set(key, {
        schemaId,
        controlId,
        value: existing.value,
        timer: undefined,
        lastSentAt: now()
      });
    }, sliderThrottleMs - (currentTime - existing.lastSentAt));
  }

  function commitValue(schemaId: string, controlId: string) {
    if (blockIfStale(schemaId)) return;

    const key = pendingKey(schemaId, controlId);
    const pending = pendingPatches.get(key);
    if (!pending) {
      const control = findControl(schemaId, controlId);
      if (!control || !isValueControl(control)) return;
      const value = state.values[schemaId]?.[controlId] ?? control.value ?? control.defaultValue;
      const validation = validateControlValue(control, value);
      if (!validation.ok) {
        setState({ notice: `Invalid commit value for ${control.label}: ${validation.message}` });
        return;
      }
      sendCommit(schemaId, controlId, value);
      return;
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    sendCommit(schemaId, controlId, pending.value);
    pendingPatches.delete(key);
  }

  function fireTrigger(schemaId: string, controlId: string) {
    if (blockIfStale(schemaId)) return;
    const control = findControl(schemaId, controlId);
    sendTrigger(schemaId, controlId);
    markPatch(controlId, control?.label ?? controlId);
  }

  function saveCompareSlot(slot: CompareSlotId, schemaId: string) {
    const values = state.values[schemaId] ?? {};
    const schemaSlots = state.compareSlots[schemaId] ?? {};
    setState({
      compareSlots: {
        ...state.compareSlots,
        [schemaId]: {
          ...schemaSlots,
          [slot]: structuredClone(values)
        }
      }
    });
  }

  function applyCompareSlot(slot: CompareSlotId, schemaId: string) {
    if (blockIfStale(schemaId)) return;

    const snapshot = state.compareSlots[schemaId]?.[slot];
    const schema = schemasById.get(schemaId);
    if (!schema || !snapshot) return;

    const validSnapshot = filterValidSnapshot(schema, snapshot);
    setState({
      values: {
        ...state.values,
        [schemaId]: validSnapshot
      }
    });
    sendBatchPatch(schemaId, validSnapshot, true);

    const replayTrigger = findReplayTrigger(schema);
    if (replayTrigger) {
      setTimeout(() => {
        sendTrigger(schemaId, replayTrigger.id);
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

  function applySource(schemaId: string, controlIds?: string[]): void {
    const schema = schemasById.get(schemaId);
    if (!schema) return;

    const controlsById = controlsByIdForSchema(schema);
    const candidateControls = controlIds
      ? controlIds.map((controlId) => controlsById.get(controlId)).filter((control): control is InspectorControl => Boolean(control))
      : Array.from(controlsById.values());

    const schemaValues = state.values[schemaId] ?? {};
    const requests: SourceApplyRequest[] = [];

    for (const control of candidateControls) {
      if (!isValueControl(control)) continue;
      if (!control.source) continue;
      const value = schemaValues[control.id] ?? control.value ?? control.defaultValue;
      requests.push({
        controlId: control.id,
        kind: control.kind,
        anchor: control.source,
        value
      });
    }

    if (requests.length === 0) return;

    send({
      type: "source.apply",
      schemaId,
      requests
    });
  }

  function startRecording(
    schemaId: string,
    probeIds: string[],
    sampleRateHz = 60
  ): string | undefined {
    if (blockIfStale(schemaId)) return undefined;
    if (probeIds.length === 0) {
      setState({ notice: "Select at least one runtime probe to record." });
      return undefined;
    }
    if (state.recording && !state.recording.complete) {
      setState({ notice: "A recording is already active." });
      return undefined;
    }

    recordingCounter += 1;
    const recordingId = `rec-${clientId}-${Math.round(now())}-${recordingCounter}`;
    setState({
      recording: {
        id: recordingId,
        schemaId,
        probeIds: [...probeIds],
        sampleRateHz,
        samples: [],
        nextSequence: 0,
        complete: false,
        incomplete: false
      },
      notice: undefined
    });
    send({
      type: "recording.start",
      recordingId,
      schemaId,
      probeIds,
      sampleRateHz
    });
    return recordingId;
  }

  function stopRecording() {
    const recording = state.recording;
    if (!recording || recording.complete) return;
    send({
      type: "recording.stop",
      recordingId: recording.id,
      schemaId: recording.schemaId
    });
  }

  function clearRecording() {
    if (state.recording && !state.recording.complete) {
      setState({ notice: "Stop the active recording before clearing it." });
      return;
    }
    setState({ recording: undefined });
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
    exportTypeScript,
    applySource,
    startRecording,
    stopRecording,
    clearRecording
  };
}

function filterValidSnapshot(schema: PanelSchema, snapshot: Record<string, unknown>) {
  const controlsById = controlsByIdForSchema(schema);

  return Object.fromEntries(
    Object.entries(snapshot).filter(([controlId, value]) => {
      const control = controlsById.get(controlId);
      return control ? isValidControlValue(control, value) : false;
    })
  );
}

function controlsByIdForSchema(schema: PanelSchema) {
  return new Map<string, InspectorControl>(
    schema.groups.flatMap((group) => group.controls.map((control) => [control.id, control] as const))
  );
}

function findControlInSchema(schema: PanelSchema, controlId: string): InspectorControl | undefined {
  for (const group of schema.groups) {
    const found = group.controls.find((control) => control.id === controlId);
    if (found) return found;
  }
  return undefined;
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