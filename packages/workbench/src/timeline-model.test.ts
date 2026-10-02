import { describe, expect, it } from "vitest";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type { PanelSchema } from "@runtime-inspector/protocol";
import {
  buildTimelineModel,
  latestAnimationBurst,
  movedStartDelay,
  parameterControl,
  resizedDurationMs,
  resizedFromStart,
  resolveSliderControl,
  splitAnimationTarget,
  startControl,
  timelineOriginMs,
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
      value: 260,
      unit: "ms"
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
  it("groups rows by element in order of first appearance by start time", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "b", target: "card.moveX", startedAtRuntimeMs: 1200 }),
      trace({ instanceId: "c", target: "badge.opacity", startedAtRuntimeMs: 1100 }),
      trace({ instanceId: "a", target: "card.opacity", startedAtRuntimeMs: 1300 }),
      trace({ instanceId: "d", target: "screen.card.scale", startedAtRuntimeMs: 1400 }),
      trace({ instanceId: "e", target: "progress", startedAtRuntimeMs: 1500 })
    ]);
    expect(model.groups.map((group) => group.id)).toEqual([
      "badge",
      "card",
      "screen.card",
      "progress"
    ]);
    expect(model.groups.map((group) => group.label)).toEqual([
      "badge",
      "card",
      "screen.card",
      "progress"
    ]);
    expect(model.groups[1]?.rows.map((row) => row.animation.instanceId)).toEqual([
      "b",
      "a"
    ]);
    expect(model.groups[1]?.rows.map((row) => row.label)).toEqual(["Move X", "Opacity"]);
    expect(model.originMs).toBe(1100);
    expect(model.groups[1]?.rows.map((row) => row.startMs)).toEqual([100, 200]);
  });

  it("orders a timing before the later spring of the same property", () => {
    const model = buildTimelineModel([
      trace({
        instanceId: "spring",
        animationKind: "spring",
        startedAtRuntimeMs: 1260,
        expectedDurationMs: 986,
        durationBasis: "spring-estimate"
      }),
      trace({ instanceId: "timing", startedAtRuntimeMs: 1000 })
    ]);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]?.rows.map((row) => row.animation.instanceId)).toEqual([
      "timing",
      "spring"
    ]);
    expect(model.groups[0]?.rows.map((row) => row.kindLabel)).toEqual([
      "Timing",
      "Spring"
    ]);
  });

  it("keeps original order for equal starts", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "late", target: "card.scale", startedAtRuntimeMs: 1200 }),
      trace({ instanceId: "first", target: "card.moveX", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "second", target: "card.opacity", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "third", target: "card.moveY", startedAtRuntimeMs: 1000 })
    ]);
    expect(model.groups[0]?.rows.map((row) => row.animation.instanceId)).toEqual([
      "first",
      "second",
      "third",
      "late"
    ]);
  });

  it("marks only unfinished spring estimates as estimated", () => {
    const spring = {
      animationKind: "spring" as const,
      expectedDurationMs: 986,
      durationBasis: "spring-estimate" as const
    };
    const model = buildTimelineModel([
      trace({ instanceId: "timing" }),
      trace({ instanceId: "running", target: "card.scale", ...spring }),
      trace({
        instanceId: "ended",
        target: "card.opacity",
        ...spring,
        endedAtRuntimeMs: 1900
      }),
      trace({
        instanceId: "unknown",
        target: "card.rotate",
        expectedDurationMs: undefined,
        durationBasis: undefined
      })
    ]);
    const rows = Object.fromEntries(
      model.groups[0]!.rows.map((row) => [row.animation.instanceId, row])
    );
    expect(rows.timing).toMatchObject({ estimated: false, durationMs: 260 });
    expect(rows.running).toMatchObject({ estimated: true, durationMs: 986 });
    expect(rows.ended).toMatchObject({ estimated: false, durationMs: 900 });
    expect(rows.unknown).toMatchObject({ estimated: false, durationMs: undefined });
  });

  it("exposes the start delay of each row, 0 when the trace has none", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "plain", target: "card.moveX" }),
      trace({
        instanceId: "delayed",
        target: "card.opacity",
        startedAtRuntimeMs: 1300,
        startDelayMs: 300
      })
    ]);
    const rows = Object.fromEntries(
      model.groups[0]!.rows.map((row) => [row.animation.instanceId, row])
    );
    expect(rows.plain).toMatchObject({ delayMs: 0, startMs: 0 });
    expect(rows.delayed).toMatchObject({ delayMs: 300, startMs: 300 });
    expect(model.originMs).toBe(1000);
    // The call time (start - delay) of the delayed row is the timeline origin.
    expect(rows.delayed!.startMs - rows.delayed!.delayMs).toBe(0);
  });

  it("places minor ticks at the midpoints between ticks", () => {
    const model = buildTimelineModel([trace()]);
    expect(model.durationMs).toBe(300);
    expect(model.ticks).toEqual([0, 50, 100, 150, 200, 250, 300]);
    expect(model.minorTicks).toEqual([25, 75, 125, 175, 225, 275]);
  });
});

describe("splitAnimationTarget", () => {
  it("splits at the last dot", () => {
    expect(splitAnimationTarget("card.moveX")).toEqual({ group: "card", label: "Move X" });
    expect(splitAnimationTarget("screen.card.scale")).toEqual({
      group: "screen.card",
      label: "Scale"
    });
  });

  it("splits camelCase at the first lower-to-upper boundary", () => {
    expect(splitAnimationTarget("titleY")).toEqual({ group: "title", label: "Y" });
    expect(splitAnimationTarget("coverOpacity")).toEqual({
      group: "cover",
      label: "Opacity"
    });
    expect(splitAnimationTarget("buttonScale")).toEqual({
      group: "button",
      label: "Scale"
    });
    expect(splitAnimationTarget("detailsOpacity")).toEqual({
      group: "details",
      label: "Opacity"
    });
  });

  it("keeps a single word as its own group", () => {
    expect(splitAnimationTarget("progress")).toEqual({
      group: "progress",
      label: "Progress"
    });
  });

  it("groups camelCase rows of the same element together", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "a", target: "titleOpacity", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "b", target: "titleY", startedAtRuntimeMs: 1100 }),
      trace({ instanceId: "c", target: "buttonScale", startedAtRuntimeMs: 1200 })
    ]);
    expect(model.groups.map((group) => group.id)).toEqual(["title", "button"]);
    expect(model.groups[0]?.rows.map((row) => row.label)).toEqual(["Opacity", "Y"]);
  });
});

describe("timelineOriginMs", () => {
  it("is 0 for an empty list", () => {
    expect(timelineOriginMs([])).toBe(0);
  });

  it("uses the earliest call time, not the earliest start", () => {
    const animations = [
      trace({ instanceId: "delayed", startedAtRuntimeMs: 1500, startDelayMs: 500 }),
      trace({ instanceId: "later", startedAtRuntimeMs: 1200 })
    ];
    expect(timelineOriginMs(animations)).toBe(1000);
    const model = buildTimelineModel(animations);
    expect(model.originMs).toBe(1000);
    const rows = Object.fromEntries(
      model.groups[0]!.rows.map((row) => [row.animation.instanceId, row.startMs])
    );
    expect(rows).toEqual({ delayed: 500, later: 200 });
  });
});

describe("latestAnimationBurst", () => {
  it("returns an empty list for no animations", () => {
    expect(latestAnimationBurst([])).toEqual([]);
  });

  it("keeps one interaction with long delays as one burst", () => {
    const burst = [
      trace({ instanceId: "a", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "b", startedAtRuntimeMs: 3000.4, startDelayMs: 2000 }),
      trace({ instanceId: "c", startedAtRuntimeMs: 1000.8 })
    ];
    expect(latestAnimationBurst(burst).map((a) => a.instanceId)).toEqual(["a", "b", "c"]);
  });

  it("returns only the last of two interactions 3 s apart", () => {
    const animations = [
      trace({ instanceId: "old1", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "new2", startedAtRuntimeMs: 4200, startDelayMs: 200 }),
      trace({ instanceId: "old2", startedAtRuntimeMs: 1100 }),
      trace({ instanceId: "new1", startedAtRuntimeMs: 4000 })
    ];
    expect(latestAnimationBurst(animations).map((a) => a.instanceId)).toEqual([
      "new2",
      "new1"
    ]);
  });

  it("honors a custom idle gap", () => {
    const animations = [
      trace({ instanceId: "a", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "b", startedAtRuntimeMs: 1300 })
    ];
    expect(latestAnimationBurst(animations, 200).map((a) => a.instanceId)).toEqual(["b"]);
    expect(latestAnimationBurst(animations).map((a) => a.instanceId)).toEqual(["a", "b"]);
  });
});

describe("slider control resolvers", () => {
  const springSchema: PanelSchema = {
    id: "auto",
    title: "Auto",
    groups: [
      {
        id: "g",
        label: "G",
        controls: [
          slider,
          { id: "damp", kind: "slider", label: "Damping", defaultValue: 14, min: 0, max: 100, step: 0.1 },
          { id: "delay", kind: "slider", label: "Delay", defaultValue: 140, min: 0, max: 10000, step: 1, unit: "ms" },
          { id: "toggle", kind: "toggle", label: "T", defaultValue: false }
        ] as never
      }
    ]
  };

  it("resolves spring parameter keys", () => {
    const spring = trace({
      animationKind: "spring",
      parameterControls: {
        damping: { schemaId: "auto", controlId: "damp" },
        stiffness: { schemaId: "auto", controlId: "missing" }
      }
    });
    expect(parameterControl(spring, "damping", [springSchema], {})).toEqual({
      schemaId: "auto",
      controlId: "damp",
      min: 0,
      max: 100,
      step: 0.1,
      value: 14
    });
    expect(parameterControl(spring, "stiffness", [springSchema], {})).toBeUndefined();
    expect(parameterControl(spring, "mass", [springSchema], {})).toBeUndefined();
  });

  it("resolves the start control with live values", () => {
    const delayed = trace({ startControl: { schemaId: "auto", controlId: "delay" } });
    expect(startControl(delayed, [springSchema], {})?.value).toBe(140);
    expect(startControl(delayed, [springSchema], { auto: { delay: 600 } })).toMatchObject({
      controlId: "delay",
      value: 600,
      unit: "ms"
    });
    expect(startControl(trace(), [springSchema], {})).toBeUndefined();
  });

  it("rejects non-slider and non-finite values", () => {
    expect(
      resolveSliderControl({ schemaId: "auto", controlId: "toggle" }, [springSchema], {})
    ).toBeUndefined();
    expect(resolveSliderControl(undefined, [springSchema], {})).toBeUndefined();
    expect(
      resolveSliderControl({ schemaId: "auto", controlId: "delay" }, [springSchema], {
        auto: { delay: Number.NaN }
      })?.value
    ).toBe(140);
  });
});

describe("movedStartDelay", () => {
  const range = { min: 0, max: 1000, step: 10 };

  it("adds the delta and snaps to step", () => {
    expect(movedStartDelay({ delay: 100, deltaMs: 43, ...range })).toBe(140);
    expect(movedStartDelay({ delay: 100, deltaMs: -46, ...range })).toBe(50);
  });

  it("bounds to [min, max]", () => {
    expect(movedStartDelay({ delay: 100, deltaMs: -500, ...range })).toBe(0);
    expect(movedStartDelay({ delay: 900, deltaMs: 500, ...range })).toBe(1000);
  });

  it("treats step <= 0 as 1 and stays finite", () => {
    expect(movedStartDelay({ delay: 10, deltaMs: 3.4, ...range, step: 0 })).toBe(13);
    expect(Number.isFinite(movedStartDelay({ delay: 10, deltaMs: Number.NaN, ...range }))).toBe(true);
  });
});

describe("resizedFromStart", () => {
  const delayRange = { min: 0, max: 1000, step: 10 };
  const durationRange = { min: 50, max: 1000, step: 10 };
  const base = { delay: 200, duration: 300, delayRange, durationRange };

  it("keeps the end fixed", () => {
    expect(resizedFromStart({ ...base, deltaMs: 100 })).toEqual({ delay: 300, duration: 200 });
    expect(resizedFromStart({ ...base, deltaMs: -100 })).toEqual({ delay: 100, duration: 400 });
  });

  it("snaps the delta", () => {
    const result = resizedFromStart({ ...base, deltaMs: 43 });
    expect(result).toEqual({ delay: 240, duration: 260 });
    expect(result.delay + result.duration).toBe(500);
  });

  it("clips at the delay bound and gives the duration only the applied delta", () => {
    expect(resizedFromStart({ ...base, deltaMs: -500 })).toEqual({ delay: 0, duration: 500 });
  });

  it("re-derives the delay when the duration minimum clips", () => {
    // Dragging 280 ms right wants a 20 ms duration; clipped to 50, the delay stops at 450 so the end stays at 500.
    expect(resizedFromStart({ ...base, deltaMs: 280 })).toEqual({ delay: 450, duration: 50 });
    expect(resizedFromStart({ ...base, deltaMs: 900 })).toEqual({ delay: 450, duration: 50 });
  });

  it("re-derives the delay when the duration maximum clips", () => {
    const wide = { ...base, delay: 800, duration: 100, durationRange: { min: 50, max: 400, step: 10 } };
    // Dragging 600 ms left wants 700 ms (clipped to 400): delay becomes 500 so the end stays at 900.
    expect(resizedFromStart({ ...wide, deltaMs: -600 })).toEqual({ delay: 500, duration: 400 });
  });

  it("keeps the bounded delay when the end cannot be preserved", () => {
    const tight = { ...base, delay: 100, duration: 100, durationRange: { min: 50, max: 150, step: 10 } };
    // End 200; dragging far left wants delay 0 / duration 200, clipped to 150: delay 50 keeps the end.
    expect(resizedFromStart({ ...tight, deltaMs: -500 })).toEqual({ delay: 50, duration: 150 });
    // The delay range [15, 20] cannot absorb the clipped duration (end 120, min duration 110 -> delay 10): keep the bounded delay.
    expect(
      resizedFromStart({
        delay: 20,
        duration: 100,
        delayRange: { min: 15, max: 20, step: 5 },
        durationRange: { min: 110, max: 500, step: 10 },
        deltaMs: 5
      })
    ).toEqual({ delay: 20, duration: 110 });
  });
});
