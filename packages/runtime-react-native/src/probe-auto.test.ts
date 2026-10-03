import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RIPMessage } from "@runtime-inspector/protocol";

/** Minimal hook runtime: `useEffect` runs immediately and its cleanup is kept for unmount. */
const hooks = vi.hoisted(() => {
  const cleanups: Array<() => void> = [];
  return {
    cleanups,
    unmount() {
      for (const cleanup of cleanups.splice(0)) cleanup();
    }
  };
});

vi.mock("react", () => ({
  useRef<T>(initial: T) {
    return { current: initial };
  },
  useEffect(effect: () => void | (() => void)) {
    const cleanup = effect();
    if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
  }
}));

const META = { component: "ProductRevealDemo", file: "src/ProductRevealDemo.tsx" };

async function load() {
  await import("./index");
  const probes = await import("./probe-auto");
  const recording = await import("./recording");
  const auto = await import("./auto");
  const messages: RIPMessage[] = [];
  recording.setRuntimeTraceEmitter((_schemaId, message) => messages.push(message));
  return { probes, recording, auto, messages };
}

function traceTypes(messages: RIPMessage[]): string[] {
  return messages.map((message) => message.type);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  hooks.unmount();
  const { __resetAutoProbesForTests } = await import("./probe-auto");
  __resetAutoProbesForTests();
  const { __resetAutoRegistryForTests } = await import("./auto");
  __resetAutoRegistryForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("acquireAutoProbe", () => {
  it("registers a labelled number probe in the auto trace schema", async () => {
    const { probes, recording } = await load();
    const release = probes.acquireAutoProbe({ value: 24 }, "titleY", META);

    expect(release).toBeTypeOf("function");
    expect(recording.getTraceSchema("auto")).toEqual({
      type: "trace.schema.publish",
      schemaId: "auto",
      probes: [{ id: "ProductRevealDemo.titleY", valueType: "number", label: "Product reveal demo · titleY" }]
    });
  });

  it("registers a boolean probe", async () => {
    const { probes, recording } = await load();
    probes.acquireAutoProbe({ value: false }, "visible", META);
    expect(recording.getTraceSchema("auto")?.probes[0]).toMatchObject({ valueType: "boolean" });
  });

  it.each([
    ["a string value", { value: "#fff" }],
    ["an object value", { value: { x: 1 } }],
    ["a non-object", 3],
    ["null", null]
  ])("skips %s", async (_label, sharedValue) => {
    const { probes, recording } = await load();
    expect(probes.acquireAutoProbe(sharedValue, "x", META)).toBeUndefined();
    expect(recording.getTraceSchema("auto")).toBeUndefined();
  });

  it("registers once per (component, name), follows the latest shared value, and releases with the last instance", async () => {
    const { probes, recording, messages } = await load();
    const first = { value: 1 };
    const second = { value: 2 };

    const releaseFirst = probes.acquireAutoProbe(first, "titleY", META)!;
    const releaseSecond = probes.acquireAutoProbe(second, "titleY", META)!;
    expect(traceTypes(messages)).toEqual(["trace.schema.publish"]);
    expect(recording.getTraceSchema("auto")?.probes).toHaveLength(1);

    // The registered source reads the latest instance.
    const frames: Array<(time: number) => void> = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(performance, "now").mockReturnValue(100);
    recording.handleRecordingStart({
      type: "recording.start",
      recordingId: "rec",
      schemaId: "auto",
      probeIds: ["ProductRevealDemo.titleY"],
      sampleRateHz: 60
    });
    frames.shift()!(100);
    recording.handleRecordingStop({ type: "recording.stop", recordingId: "rec", schemaId: "auto" });
    const chunk = messages.find((message) => message.type === "recording.chunk") as
      | { samples: Array<{ values: Record<string, unknown> }> }
      | undefined;
    expect(chunk?.samples[0].values).toEqual({ "ProductRevealDemo.titleY": 2 });

    releaseFirst();
    releaseFirst();
    expect(recording.getTraceSchema("auto")?.probes).toHaveLength(1);
    releaseSecond();
    expect(recording.getTraceSchema("auto")).toBeUndefined();
    expect(traceTypes(messages).at(-1)).toBe("trace.schema.dispose");
  });

  it("keeps at most 16 automatic probes and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { probes, recording } = await load();
    for (let index = 0; index < 18; index += 1) {
      probes.acquireAutoProbe({ value: index }, `value${index}`, META);
    }

    expect(recording.getTraceSchema("auto")?.probes).toHaveLength(16);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"ProductRevealDemo.value16"');
  });

  it("registers nothing in production", async () => {
    vi.stubGlobal("__DEV__", false);
    const { probes, recording } = await load();
    expect(probes.acquireAutoProbe({ value: 1 }, "titleY", META)).toBeUndefined();
    expect(recording.getTraceSchema("auto")).toBeUndefined();
  });
});

describe("__riProbe", () => {
  it("returns the shared value unchanged, registers while mounted and unregisters on unmount", async () => {
    const { probes, recording } = await load();
    const sharedValue = { value: 24 };

    expect(probes.__riProbe(sharedValue, "titleY", META)).toBe(sharedValue);
    expect(recording.getTraceSchema("auto")?.probes.map((probe) => probe.id)).toEqual([
      "ProductRevealDemo.titleY"
    ]);

    hooks.unmount();
    expect(recording.getTraceSchema("auto")).toBeUndefined();
  });

  it("composes with __riInspect", async () => {
    const { probes, recording, auto } = await load();
    const sharedValue = { value: 0.5 };

    const inspected = auto.__riInspect(sharedValue, "opacity", { min: 0, max: 1 });
    expect(probes.__riProbe(inspected, "opacity", META)).toBe(sharedValue);
    expect(recording.getTraceSchema("auto")?.probes).toEqual([
      { id: "ProductRevealDemo.opacity", valueType: "number", label: "Product reveal demo · opacity" }
    ]);
  });

  it("returns the shared value and registers nothing in production", async () => {
    vi.stubGlobal("__DEV__", false);
    const { probes, recording } = await load();
    const sharedValue = { value: 24 };
    expect(probes.__riProbe(sharedValue, "titleY", META)).toBe(sharedValue);
    expect(recording.getTraceSchema("auto")).toBeUndefined();
  });
});
