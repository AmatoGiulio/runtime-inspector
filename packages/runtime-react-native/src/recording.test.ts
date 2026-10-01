import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleRecordingStart,
  handleRecordingStop,
  registerRuntimeProbe,
  setRuntimeTraceEmitter,
  stopAllRuntimeRecordings
} from "./recording";

describe("runtime recording M0", () => {
  const frames: Array<(time: number) => void> = [];
  let nextFrameId = 0;

  beforeEach(() => {
    frames.length = 0;
    nextFrameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frames.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    stopAllRuntimeRecordings();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("batches 60 Hz probe samples into recording chunks", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(100);

    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    setRuntimeTraceEmitter((_schemaId, message) => {
      messages.push(message as { type: string; [key: string]: unknown });
    });

    const source = { value: 0 };
    const dispose = registerRuntimeProbe(
      "card-transition",
      { id: "moveX", valueType: "number", unit: "px" },
      source
    );

    handleRecordingStart({
      type: "recording.start",
      recordingId: "rec-test",
      schemaId: "card-transition",
      probeIds: ["moveX"],
      sampleRateHz: 60
    });

    for (let i = 0; i < 9; i += 1) {
      const callback = frames.shift();
      expect(callback).toBeDefined();
      source.value = i * -10;
      callback!(100 + i * 17);
    }

    now.mockReturnValue(260);
    handleRecordingStop({
      type: "recording.stop",
      recordingId: "rec-test",
      schemaId: "card-transition"
    });

    const chunks = messages.filter((message) => message.type === "recording.chunk");
    expect(messages.some((message) => message.type === "recording.started")).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.some((chunk) =>
        (chunk.samples as Array<{ values: Record<string, number> }>).some(
          (sample) => typeof sample.values.moveX === "number"
        )
      )
    ).toBe(true);
    expect(messages.some((message) => message.type === "recording.complete")).toBe(true);

    dispose();
  });

  it("rejects a recording request for an unknown probe", () => {
    const messages: Array<{ type: string; code?: string }> = [];
    setRuntimeTraceEmitter((_schemaId, message) => {
      messages.push(message as { type: string; code?: string });
    });

    handleRecordingStart({
      type: "recording.start",
      recordingId: "rec-missing",
      schemaId: "missing-schema",
      probeIds: ["moveX"],
      sampleRateHz: 60
    });

    expect(messages).toContainEqual(
      expect.objectContaining({ type: "error", code: "TRACE_SCHEMA_MISSING" })
    );
  });
});
