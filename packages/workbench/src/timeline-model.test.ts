import { describe, expect, it } from "vitest";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";
import {
  buildTimelineModel,
  resizedDurationMs,
  timingDurationControl
} from "./timeline-model";

function trace(overrides: Partial<RuntimeAnimationTrace> = {}): RuntimeAnimationTrace {
  return {
    type: "animation.started",
    instanceId: "a1",
    callsiteId: "App.tsx:10:2",
    schemaId: "auto",
    target: "card.moveX",
    animationKind: "timing",
    startedAtRuntimeMs: 1000,
    config: { duration: 260 },
    resolvedConfig: { duration: 260 },
    expectedDurationMs: 260,
    durationBasis: "declared",
    parameterControls: { duration: { schemaId: "auto", controlId: "dur" } },
    ...overrides
  };
}

function schema(control: Record<string, unknown>): PanelSchema {
  return {
    id: "auto",
    title: "Auto",
    groups: [{ id: "g", label: "G", controls: [control as never] }]
  };
}

const slider = {
  id: "dur",
  kind: "slider",
  label: "Duration",
  defaultValue: 260,
  min: 0,
  max: 10000,
  step: 5,
  unit: "ms"
};

describe("resizedDurationMs", () => {
  const base = { startMs: 100, min: 0, max: 1000, step: 10 };

  it("snaps to step", () => {
    expect(resizedDurationMs({ ...base, pointerMs: 100 + 263 })).toBe(260);
    expect(resizedDurationMs({ ...base, pointerMs: 100 + 267 })).toBe(270);
  });

  it("bounds to max", () => {
    expect(resizedDurationMs({ ...base, pointerMs: 100 + 5000 })).toBe(1000);
  });

  it("returns min when the pointer is left of the span start", () => {
    expect(resizedDurationMs({ ...base, min: 50, pointerMs: 20 })).toBe(50);
  });

  it("treats step <= 0 as 1", () => {
    expect(resizedDurationMs({ ...base, step: 0, pointerMs: 100 + 263.4 })).toBe(263);
    expect(resizedDurationMs({ ...base, step: -5, pointerMs: 100 + 263.6 })).toBe(264);
  });
});

describe("timingDurationControl", () => {
  it("resolves for a timing trace with a matching slider", () => {
    expect(timingDurationControl(trace(), [schema(slider)], {})).toEqual({
      schemaId: "auto",
      controlId: "dur",
      min: 0,
      max: 10000,
      step: 5,
      value: 260
    });
  });

  it("prefers live values", () => {
    expect(
      timingDurationControl(trace(), [schema({ ...slider, value: 300 })], {
        auto: { dur: 450 }
      })?.value
    ).toBe(450);
  });

  it("falls back to control value, then defaultValue", () => {
    expect(
      timingDurationControl(trace(), [schema({ ...slider, value: 300 })], {})?.value
    ).toBe(300);
    expect(timingDurationControl(trace(), [schema(slider)], { auto: {} })?.value).toBe(260);
  });

  it("returns undefined for a spring trace", () => {
    expect(
      timingDurationControl(trace({ animationKind: "spring" }), [schema(slider)], {})
    ).toBeUndefined();
  });

  it("returns undefined for a missing schema", () => {
    expect(timingDurationControl(trace(), [], {})).toBeUndefined();
  });

  it("returns undefined for a missing control", () => {
    expect(
      timingDurationControl(trace(), [schema({ ...slider, id: "other" })], {})
    ).toBeUndefined();
  });

  it("returns undefined for a non-slider control", () => {
    expect(
      timingDurationControl(
        trace(),
        [schema({ id: "dur", kind: "toggle", label: "T", defaultValue: false })],
        {}
      )
    ).toBeUndefined();
  });

  it("returns undefined without parameterControls", () => {
    expect(
      timingDurationControl(trace({ parameterControls: undefined }), [schema(slider)], {})
    ).toBeUndefined();
  });
});

describe("buildTimelineModel", () => {
  it("builds one track per target with animations sorted by start", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "b", target: "card.moveX", startedAtRuntimeMs: 1200 }),
      trace({ instanceId: "c", target: "card.opacity", startedAtRuntimeMs: 1100 }),
      trace({ instanceId: "a", target: "card.moveX", startedAtRuntimeMs: 1000 })
    ]);
    expect(model.tracks.map((track) => track.target)).toEqual([
      "card.moveX",
      "card.opacity"
    ]);
    expect(model.tracks[0]?.animations.map((a) => a.instanceId)).toEqual(["a", "b"]);
    expect(model.originMs).toBe(1000);
  });
});
