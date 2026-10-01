import type {
  RecordingChunk,
  RecordingComplete,
  RecordingStart,
  RecordingStop,
  RIPMessage,
  RuntimeProbeDescriptor,
  RuntimeProbeValue,
  TraceSchemaPublish
} from "@runtime-inspector/protocol";

export interface RuntimeProbeSource {
  value: RuntimeProbeValue;
}

interface RegisteredProbe {
  descriptor: RuntimeProbeDescriptor;
  source: RuntimeProbeSource;
}

interface ActiveRecording {
  request: RecordingStart;
  startedAtMs: number;
  lastSampleAtMs: number;
  lastFlushAtMs: number;
  sequence: number;
  sampleCount: number;
  samples: RecordingChunk["samples"];
}

type RuntimeTraceEmitter = (schemaId: string, message: RIPMessage) => void;

const probesBySchema = new Map<string, Map<string, RegisteredProbe>>();
const activeRecordings = new Map<string, ActiveRecording>();
let emitRuntimeTrace: RuntimeTraceEmitter | undefined;
let rafHandle: number | undefined;

const CHUNK_FLUSH_MS = 100;
const MAX_RECORDING_MS = 10_000;

function nowMs() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function requestFrame(callback: (time: number) => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(() => callback(nowMs()), 16) as unknown as number;
}

function cancelFrame(handle: number) {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export function setRuntimeTraceEmitter(emitter: RuntimeTraceEmitter) {
  emitRuntimeTrace = emitter;
}

export function registerRuntimeProbe(
  schemaId: string,
  descriptor: RuntimeProbeDescriptor,
  source: RuntimeProbeSource
): () => void {
  const schemaProbes = probesBySchema.get(schemaId) ?? new Map<string, RegisteredProbe>();
  schemaProbes.set(descriptor.id, { descriptor, source });
  probesBySchema.set(schemaId, schemaProbes);
  publishTraceSchema(schemaId);

  return () => {
    const current = probesBySchema.get(schemaId);
    if (!current) return;
    current.delete(descriptor.id);
    if (current.size === 0) {
      probesBySchema.delete(schemaId);
      emitRuntimeTrace?.(schemaId, { type: "trace.schema.dispose", schemaId });
      return;
    }
    publishTraceSchema(schemaId);
  };
}

export function getTraceSchema(schemaId: string): TraceSchemaPublish | undefined {
  const probes = probesBySchema.get(schemaId);
  if (!probes || probes.size === 0) return undefined;
  return {
    type: "trace.schema.publish",
    schemaId,
    probes: Array.from(probes.values(), (entry) => entry.descriptor)
  };
}

export function listTraceSchemas(): TraceSchemaPublish[] {
  return Array.from(probesBySchema.keys())
    .map(getTraceSchema)
    .filter((schema): schema is TraceSchemaPublish => Boolean(schema));
}

export function handleRecordingStart(message: RecordingStart) {
  if (activeRecordings.has(message.recordingId)) return;

  const activeForSchema = Array.from(activeRecordings.values()).some(
    (recording) => recording.request.schemaId === message.schemaId
  );
  if (activeForSchema) {
    emitRuntimeTrace?.(message.schemaId, {
      type: "error",
      code: "RECORDING_ACTIVE",
      message: `A recording is already active for schema "${message.schemaId}".`
    });
    return;
  }

  const probes = probesBySchema.get(message.schemaId);
  if (!probes) {
    emitRuntimeTrace?.(message.schemaId, {
      type: "error",
      code: "TRACE_SCHEMA_MISSING",
      message: `No runtime probes are registered for schema "${message.schemaId}".`
    });
    return;
  }

  const missing = message.probeIds.filter((probeId) => !probes.has(probeId));
  if (missing.length > 0) {
    emitRuntimeTrace?.(message.schemaId, {
      type: "error",
      code: "UNKNOWN_PROBE",
      message: `Unknown runtime probe(s): ${missing.join(", ")}.`
    });
    return;
  }

  const startedAtMs = nowMs();
  activeRecordings.set(message.recordingId, {
    request: message,
    startedAtMs,
    lastSampleAtMs: Number.NEGATIVE_INFINITY,
    lastFlushAtMs: startedAtMs,
    sequence: 0,
    sampleCount: 0,
    samples: []
  });

  emitRuntimeTrace?.(message.schemaId, {
    type: "recording.started",
    recordingId: message.recordingId,
    schemaId: message.schemaId,
    probeIds: message.probeIds,
    sampleRateHz: message.sampleRateHz,
    startedAtRuntimeMs: startedAtMs
  });

  ensureFrameLoop();
}

export function handleRecordingStop(message: RecordingStop) {
  const recording = activeRecordings.get(message.recordingId);
  if (!recording || recording.request.schemaId !== message.schemaId) return;
  finishRecording(recording, nowMs());
}

export function stopAllRuntimeRecordings() {
  const end = nowMs();
  for (const recording of Array.from(activeRecordings.values())) {
    finishRecording(recording, end);
  }
}

export function stopRuntimeRecordingsForSchema(schemaId: string) {
  const end = nowMs();
  for (const recording of Array.from(activeRecordings.values())) {
    if (recording.request.schemaId === schemaId) {
      finishRecording(recording, end);
    }
  }
}

function publishTraceSchema(schemaId: string) {
  const message = getTraceSchema(schemaId);
  if (message) emitRuntimeTrace?.(schemaId, message);
}

function ensureFrameLoop() {
  if (rafHandle !== undefined || activeRecordings.size === 0) return;
  rafHandle = requestFrame(onFrame);
}

function onFrame(frameTime: number) {
  rafHandle = undefined;

  for (const recording of Array.from(activeRecordings.values())) {
    sampleRecording(recording, frameTime);
  }

  if (activeRecordings.size > 0) {
    rafHandle = requestFrame(onFrame);
  }
}

function sampleRecording(recording: ActiveRecording, frameTime: number) {
  const elapsed = Math.max(0, frameTime - recording.startedAtMs);
  if (elapsed >= MAX_RECORDING_MS) {
    finishRecording(recording, frameTime);
    return;
  }

  const interval = 1000 / recording.request.sampleRateHz;
  if (frameTime - recording.lastSampleAtMs + 0.25 < interval) return;

  const schemaProbes = probesBySchema.get(recording.request.schemaId);
  if (!schemaProbes) {
    finishRecording(recording, frameTime);
    return;
  }

  const values: Record<string, RuntimeProbeValue> = {};
  for (const probeId of recording.request.probeIds) {
    const probe = schemaProbes.get(probeId);
    if (!probe) continue;
    const value = probe.source.value;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    values[probeId] = value;
  }

  recording.samples.push({ t: elapsed, values });
  recording.sampleCount += 1;
  recording.lastSampleAtMs = frameTime;

  if (
    frameTime - recording.lastFlushAtMs >= CHUNK_FLUSH_MS ||
    recording.samples.length >= 8
  ) {
    flushRecording(recording, frameTime);
  }
}

function flushRecording(recording: ActiveRecording, time: number) {
  if (recording.samples.length === 0) return;
  const samples = recording.samples;
  recording.samples = [];
  emitRuntimeTrace?.(recording.request.schemaId, {
    type: "recording.chunk",
    recordingId: recording.request.recordingId,
    schemaId: recording.request.schemaId,
    sequence: recording.sequence,
    samples
  });
  recording.sequence += 1;
  recording.lastFlushAtMs = time;
}

function finishRecording(recording: ActiveRecording, endTime: number) {
  flushRecording(recording, endTime);
  activeRecordings.delete(recording.request.recordingId);

  const complete: RecordingComplete = {
    type: "recording.complete",
    recordingId: recording.request.recordingId,
    schemaId: recording.request.schemaId,
    durationMs: Math.max(0, endTime - recording.startedAtMs),
    sampleCount: recording.sampleCount,
    complete: true
  };
  emitRuntimeTrace?.(recording.request.schemaId, complete);

  if (activeRecordings.size === 0 && rafHandle !== undefined) {
    cancelFrame(rafHandle);
    rafHandle = undefined;
  }
}