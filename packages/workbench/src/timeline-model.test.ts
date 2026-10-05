import { describe, expect, it } from "vitest";
import type { RuntimeAnimationTrace } from "@runtime-inspector/panel-core";
import type { InspectorControl, PanelSchema } from "@runtime-inspector/protocol";
import {
  PENDING_PREVIEW_TTL_MS,
  animationKeys,
  animationsSince,
  applyResultNotice,
  groupControlIdsBySchema,
  literalApplyGroups,
  mergeBurst,
  type PendingPreview,
  buildTimelineModel,
  latestAnimationBurst,
  movedStartDelay,
  nextStickyDuration,
  orderAnimations,
  parameterControl,
  playbackTargetScene,
  resizedDurationMs,
  resizedFromStart,
  resolvePendingPreview,
  resolveSliderControl,
  splitAnimationTarget,
  startControl,
  timelineOriginMs,
  timelineSignature,
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
  it("groups rows by element in order of first appearance in the input", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "b", target: "card.moveX", startedAtRuntimeMs: 1200 }),
      trace({ instanceId: "c", target: "badge.opacity", startedAtRuntimeMs: 1100 }),
      trace({ instanceId: "a", target: "card.opacity", startedAtRuntimeMs: 1300 }),
      trace({ instanceId: "d", target: "screen.card.scale", startedAtRuntimeMs: 1400 }),
      trace({ instanceId: "e", target: "progress", startedAtRuntimeMs: 1500 })
    ]);
    expect(model.groups.map((group) => group.id)).toEqual([
      "card",
      "badge",
      "screen.card",
      "progress"
    ]);
    expect(model.groups.map((group) => group.label)).toEqual([
      "card",
      "badge",
      "screen.card",
      "progress"
    ]);
    expect(model.groups[0]?.rows.map((row) => row.animation.instanceId)).toEqual([
      "b",
      "a"
    ]);
    expect(model.groups[0]?.rows.map((row) => row.label)).toEqual(["Move X", "Opacity"]);
    expect(model.originMs).toBe(1100);
    expect(model.groups[0]?.rows.map((row) => row.startMs)).toEqual([100, 200]);
  });

  it("keeps input order for rows of one group whatever their start", () => {
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
      "spring",
      "timing"
    ]);
    expect(model.groups[0]?.rows.map((row) => row.kindLabel)).toEqual([
      "Spring",
      "Timing"
    ]);
  });

  it("does not reorder groups or rows when a block is moved later", () => {
    const base = [
      trace({ instanceId: "a", callsiteId: "c1", target: "card.moveX" }),
      trace({ instanceId: "b", callsiteId: "c2", target: "badge.opacity" }),
      trace({ instanceId: "c", callsiteId: "c3", target: "card.opacity" })
    ];
    const order = (animations: RuntimeAnimationTrace[]) => {
      const model = buildTimelineModel(animations);
      return {
        groups: model.groups.map((group) => group.id),
        rows: model.groups.flatMap((group) =>
          group.rows.map((row) => row.animation.callsiteId)
        )
      };
    };
    const moved = base.map((animation, index) =>
      index === 0
        ? {
            ...animation,
            instanceId: "a2",
            startedAtRuntimeMs: animation.startedAtRuntimeMs + 700,
            startDelayMs: 700
          }
        : animation
    );
    expect(order(moved)).toEqual(order(base));
    expect(order(base)).toEqual({
      groups: ["card", "badge"],
      rows: ["c1", "c3", "c2"]
    });
  });

  it("keeps the input order for equal and unequal starts alike", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "late", target: "card.scale", startedAtRuntimeMs: 1200 }),
      trace({ instanceId: "first", target: "card.moveX", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "second", target: "card.opacity", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "third", target: "card.moveY", startedAtRuntimeMs: 1000 })
    ]);
    expect(model.groups[0]?.rows.map((row) => row.animation.instanceId)).toEqual([
      "late",
      "first",
      "second",
      "third"
    ]);
  });

  it("gives rows a key from the call site, suffixed for repeated call sites", () => {
    const model = buildTimelineModel([
      trace({ instanceId: "x1", callsiteId: "A:1:1", target: "card.moveX" }),
      trace({ instanceId: "x2", callsiteId: "A:2:1", target: "card.opacity" }),
      trace({ instanceId: "x3", callsiteId: "A:1:1", target: "card.moveX" }),
      trace({ instanceId: "x4", callsiteId: "A:1:1", target: "card.moveX" })
    ]);
    expect(model.groups[0]?.rows.map((row) => row.key)).toEqual([
      "A:1:1",
      "A:2:1",
      "A:1:1#2",
      "A:1:1#3"
    ]);
    // A new replay (new instance ids) keeps the same keys.
    const replay = buildTimelineModel([
      trace({ instanceId: "y1", callsiteId: "A:1:1", target: "card.moveX" }),
      trace({ instanceId: "y2", callsiteId: "A:2:1", target: "card.opacity" }),
      trace({ instanceId: "y3", callsiteId: "A:1:1", target: "card.moveX" }),
      trace({ instanceId: "y4", callsiteId: "A:1:1", target: "card.moveX" })
    ]);
    expect(replay.groups[0]?.rows.map((row) => row.key)).toEqual(
      model.groups[0]?.rows.map((row) => row.key)
    );
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

describe("buildTimelineModel minDurationMs", () => {
  it("keeps the content duration when no minimum is given or the minimum is smaller", () => {
    expect(buildTimelineModel([trace()]).durationMs).toBe(300);
    expect(buildTimelineModel([trace()], { minDurationMs: 100 }).durationMs).toBe(300);
    expect(buildTimelineModel([trace()], {}).ticks).toEqual([0, 50, 100, 150, 200, 250, 300]);
  });

  it("widens the ruler to the minimum, rounded up to the tick step of that duration", () => {
    const model = buildTimelineModel([trace()], { minDurationMs: 1500 });
    expect(model.durationMs).toBe(1600);
    expect(model.ticks).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600]);
    expect(model.minorTicks[0]).toBe(100);
    expect(buildTimelineModel([trace()], { minDurationMs: 500 }).durationMs).toBe(500);
  });

  it("does not change the rows or origin", () => {
    const plain = buildTimelineModel([trace()]);
    const wide = buildTimelineModel([trace()], { minDurationMs: 2000 });
    expect(wide.originMs).toBe(plain.originMs);
    expect(wide.groups[0]?.rows[0]?.startMs).toBe(plain.groups[0]?.rows[0]?.startMs);
  });
});

describe("orderAnimations", () => {
  it("orders by source file, line, column when every animation has a source", () => {
    const source = (file: string, line: number, column: number) => ({
      file,
      line,
      column,
      enclosure: [],
      expression: ""
    });
    const ordered = orderAnimations([
      trace({ instanceId: "d", source: source("b.tsx", 1, 1) }),
      trace({ instanceId: "c", source: source("a.tsx", 20, 1) }),
      trace({ instanceId: "b", source: source("a.tsx", 10, 9) }),
      trace({ instanceId: "a", source: source("a.tsx", 10, 2) }),
      trace({ instanceId: "e", source: source("b.tsx", 1, 1) })
    ]);
    expect(ordered.map((animation) => animation.instanceId)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e"
    ]);
  });

  it("falls back to input order when any source is missing", () => {
    const withSource = { file: "a.tsx", line: 1, column: 1, enclosure: [], expression: "" };
    const input = [
      trace({ instanceId: "z", source: { ...withSource, line: 99 } }),
      trace({ instanceId: "y" }),
      trace({ instanceId: "x", source: { ...withSource, line: 1 } })
    ];
    expect(orderAnimations(input).map((animation) => animation.instanceId)).toEqual([
      "z",
      "y",
      "x"
    ]);
  });

  it("drives group and row order in the model, independent of start", () => {
    const at = (line: number) => ({
      file: "a.tsx",
      line,
      column: 1,
      enclosure: [],
      expression: ""
    });
    const model = buildTimelineModel([
      trace({ instanceId: "p", target: "badge.opacity", source: at(30), startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "q", target: "card.moveX", source: at(10), startedAtRuntimeMs: 1500 }),
      trace({ instanceId: "r", target: "badge.scale", source: at(20), startedAtRuntimeMs: 1200 })
    ]);
    expect(model.groups.map((group) => group.id)).toEqual(["card", "badge"]);
    expect(model.groups[1]?.rows.map((row) => row.animation.instanceId)).toEqual(["r", "p"]);
  });
});

describe("resolvePendingPreview", () => {
  const pending: PendingPreview = {
    key: "A:1:1",
    instanceId: "run1",
    createdAtMs: 10_000,
    mode: "move",
    shiftMs: 150
  };
  const row = { key: "A:1:1", instanceId: "run1" };

  it("keeps the preview while the instance is the same and the time-to-live has not passed", () => {
    expect(resolvePendingPreview(pending, row, 10_000)).toBe(pending);
    expect(resolvePendingPreview(pending, row, 10_000 + PENDING_PREVIEW_TTL_MS - 1)).toBe(pending);
  });

  it("drops it once a new instance of the row arrives (the replay)", () => {
    expect(resolvePendingPreview(pending, { ...row, instanceId: "run2" }, 10_100)).toBeUndefined();
  });

  it("drops it after the time-to-live without a new instance", () => {
    expect(resolvePendingPreview(pending, row, 10_000 + PENDING_PREVIEW_TTL_MS)).toBeUndefined();
    expect(resolvePendingPreview(pending, row, 10_000, 0)).toBeUndefined();
  });

  it("ignores a preview that belongs to another row, or none at all", () => {
    expect(resolvePendingPreview(pending, { ...row, key: "B:2:2" }, 10_100)).toBeUndefined();
    expect(resolvePendingPreview(undefined, row, 10_100)).toBeUndefined();
  });
});

describe("animationKeys", () => {
  it("is the call site id, suffixed in input order for repeats", () => {
    expect(
      animationKeys([
        trace({ callsiteId: "a" }),
        trace({ callsiteId: "b" }),
        trace({ callsiteId: "a" }),
        trace({ callsiteId: "a" })
      ])
    ).toEqual(["a", "b", "a#2", "a#3"]);
  });
});

describe("mergeBurst", () => {
  const displayed = [
    trace({ instanceId: "o1", callsiteId: "c1", target: "card.moveX", startedAtRuntimeMs: 1000 }),
    trace({
      instanceId: "o2",
      callsiteId: "c2",
      target: "card.opacity",
      startedAtRuntimeMs: 1100,
      endedAtRuntimeMs: 1400
    }),
    trace({ instanceId: "o3", callsiteId: "c3", target: "badge.scale", startedAtRuntimeMs: 1300 })
  ];

  it("returns the other input when one side is empty", () => {
    const incoming = [trace({ instanceId: "n1", callsiteId: "c1", startedAtRuntimeMs: 5000 })];
    expect(mergeBurst(displayed, [])).toBe(displayed);
    expect(mergeBurst([], incoming)).toBe(incoming);
  });

  it("keeps the rows that have not come back, at the same relative start", () => {
    const incoming = [
      trace({ instanceId: "n1", callsiteId: "c1", target: "card.moveX", startedAtRuntimeMs: 5000 })
    ];
    const merged = mergeBurst(displayed, incoming);
    expect(merged.map((animation) => animation.instanceId)).toEqual(["n1", "o2", "o3"]);
    // Rebased by 5000 - 1000: relative starts 0, 100, 300 as before.
    expect(merged.map((animation) => animation.startedAtRuntimeMs)).toEqual([5000, 5100, 5300]);
    expect(merged[1]!.endedAtRuntimeMs).toBe(5400);
    const model = buildTimelineModel(merged);
    expect(model.originMs).toBe(5000);
    expect(model.groups.map((group) => group.id)).toEqual(["card", "badge"]);
    expect(model.groups[0]!.rows.map((row) => row.startMs)).toEqual([0, 100]);
    expect(model.groups[1]!.rows[0]!.startMs).toBe(300);
  });

  it("replaces everything when every key comes back", () => {
    const incoming = displayed.map((animation, index) => ({
      ...animation,
      instanceId: `n${index}`,
      startedAtRuntimeMs: animation.startedAtRuntimeMs + 4000
    }));
    const merged = mergeBurst(displayed, incoming);
    expect(merged).toEqual(incoming);
    expect(merged.every((animation, index) => animation === incoming[index])).toBe(true);
  });

  it("matches repeated call sites by their #n key", () => {
    const twice = [
      trace({ instanceId: "p1", callsiteId: "r", target: "card.moveX", startedAtRuntimeMs: 1000 }),
      trace({ instanceId: "p2", callsiteId: "r", target: "card.moveX", startedAtRuntimeMs: 1200 })
    ];
    const incoming = [
      trace({ instanceId: "q1", callsiteId: "r", target: "card.moveX", startedAtRuntimeMs: 3000 })
    ];
    const merged = mergeBurst(twice, incoming);
    expect(merged.map((animation) => animation.instanceId)).toEqual(["q1", "p2"]);
    expect(merged[1]!.startedAtRuntimeMs).toBe(3200);
    expect(animationKeys(merged)).toEqual(["r", "r#2"]);
  });

  it("takes an already displayed instance from incoming unchanged", () => {
    const incoming = [displayed[0]!, trace({ instanceId: "n9", callsiteId: "c9", startedAtRuntimeMs: 1050 })];
    const merged = mergeBurst(displayed, incoming);
    expect(merged[0]).toBe(displayed[0]);
    expect(merged.filter((animation) => animation.instanceId === "o1")).toHaveLength(1);
  });

  it("does not mutate its inputs", () => {
    const before = JSON.stringify(displayed);
    const incoming = [trace({ instanceId: "n1", callsiteId: "c1", startedAtRuntimeMs: 5000 })];
    const incomingBefore = JSON.stringify(incoming);
    const merged = mergeBurst(displayed, incoming);
    expect(JSON.stringify(displayed)).toBe(before);
    expect(JSON.stringify(incoming)).toBe(incomingBefore);
    expect(merged[1]).not.toBe(displayed[1]);
  });
});

describe("timelineSignature", () => {
  it("is the sorted, joined set of call site ids, independent of order and instance", () => {
    const one = timelineSignature([
      trace({ instanceId: "1", callsiteId: "b" }),
      trace({ instanceId: "2", callsiteId: "a" })
    ]);
    const two = timelineSignature([
      trace({ instanceId: "3", callsiteId: "a" }),
      trace({ instanceId: "4", callsiteId: "b" })
    ]);
    expect(one).toBe("a|b");
    expect(two).toBe(one);
    expect(timelineSignature([trace({ callsiteId: "a" })])).not.toBe(one);
  });
});

describe("nextStickyDuration", () => {
  it("starts from the content duration", () => {
    expect(nextStickyDuration(undefined, "s", 800)).toEqual({ signature: "s", durationMs: 800 });
  });

  it("grows but never shrinks for the same signature", () => {
    const first = nextStickyDuration(undefined, "s", 800);
    const grown = nextStickyDuration(first, "s", 1600);
    expect(grown).toEqual({ signature: "s", durationMs: 1600 });
    expect(nextStickyDuration(grown, "s", 400)).toEqual({ signature: "s", durationMs: 1600 });
  });

  it("resets for a different signature", () => {
    const previous = { signature: "s", durationMs: 1600 };
    expect(nextStickyDuration(previous, "t", 400)).toEqual({ signature: "t", durationMs: 400 });
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

describe("animationsSince", () => {
  it("returns an empty list for no animations", () => {
    expect(animationsSince([], 1000)).toEqual([]);
  });

  it("keeps animations called at or after the time, with 1 ms tolerance, in input order", () => {
    const animations = [
      trace({ instanceId: "before", startedAtRuntimeMs: 998.9 }),
      trace({ instanceId: "late", startedAtRuntimeMs: 1500 }),
      trace({ instanceId: "tolerance", startedAtRuntimeMs: 999.2 }),
      trace({ instanceId: "exact", startedAtRuntimeMs: 1000 })
    ];
    expect(animationsSince(animations, 1000).map((a) => a.instanceId)).toEqual([
      "late",
      "tolerance",
      "exact"
    ]);
  });

  it("uses the call time, not the delayed start", () => {
    const animations = [
      // Called at 900, starts at 1100: earlier than the scene, dropped.
      trace({ instanceId: "delayedOld", startedAtRuntimeMs: 1100, startDelayMs: 200 }),
      // Called at 1000, starts at 1300: kept.
      trace({ instanceId: "delayedNew", startedAtRuntimeMs: 1300, startDelayMs: 300 })
    ];
    expect(animationsSince(animations, 1000).map((a) => a.instanceId)).toEqual(["delayedNew"]);
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

describe("animation literal write-back helpers (RFC 0007)", () => {
  const literal = {
    file: "src/WelcomeDemo.tsx",
    line: 41,
    column: 4,
    enclosure: ["WelcomeDemo", "play"],
    target: "titleY.value",
    callee: "withTiming" as const,
    parameter: "duration" as const,
    init: "380"
  };

  function slider(id: string, defaultValue: number, withLiteral = true): InspectorControl {
    return {
      id,
      kind: "slider",
      label: id,
      defaultValue,
      min: 0,
      max: 10000,
      ...(withLiteral ? { literal } : {})
    };
  }

  it("groups the entries the session lists as pending, by schema", () => {
    const entries = [
      { schemaId: "auto", control: slider("duration", 380) },
      { schemaId: "auto", control: slider("delay", 0) },
      { schemaId: "auto", control: slider("anchored", 5, false) },
      { schemaId: "other", control: slider("delay", 0) }
    ];
    expect(
      literalApplyGroups(entries, [
        { schemaId: "auto", controlId: "duration" },
        { schemaId: "other", controlId: "delay" },
        { schemaId: "auto", controlId: "elsewhere" }
      ])
    ).toEqual([
      { schemaId: "auto", controlIds: ["duration"] },
      { schemaId: "other", controlIds: ["delay"] }
    ]);
    expect(literalApplyGroups(entries, [])).toEqual([]);
  });

  it("groups control ids by schema without duplicates", () => {
    expect(
      groupControlIdsBySchema([
        { schemaId: "a", controlId: "x" },
        { schemaId: "b", controlId: "y" },
        { schemaId: "a", controlId: "x" },
        { schemaId: "a", controlId: "z" }
      ])
    ).toEqual([
      { schemaId: "a", controlIds: ["x", "z"] },
      { schemaId: "b", controlIds: ["y"] }
    ]);
  });

  it("words the apply result notice", () => {
    expect(applyResultNotice([{ controlId: "a", ok: true, written: "1", previous: "0" }])).toBe(
      "Applied 1 change to code"
    );
    expect(
      applyResultNotice([
        { controlId: "a", ok: true, written: "1", previous: "0" },
        { controlId: "b", ok: true, written: "2", previous: "0" }
      ])
    ).toBe("Applied 2 changes to code");
    expect(applyResultNotice([{ controlId: "a", ok: false, code: "EXPRESSION_MISMATCH" }])).toBe(
      "The file changed since the app was built — reload the app and try again"
    );
    expect(
      applyResultNotice([
        { controlId: "a", ok: true, written: "1", previous: "0" },
        { controlId: "b", ok: false, code: "DECLARATION_MISSING" },
        { controlId: "c", ok: false, code: "EXPRESSION_MISMATCH" }
      ])
    ).toBe("Applied 1 of 3 changes. The code was not found in the file");
  });
});

describe("playbackTargetScene", () => {
  const scene = (id: string, active = false, reachable = false) => ({ id, active, reachable });

  it("keeps the selected scene when it is on screen", () => {
    const scenes = [scene("a", true), scene("b", false, true)];
    expect(playbackTargetScene(scenes, "a")?.id).toBe("a");
  });

  it("keeps the selected scene when it is reachable but not on screen", () => {
    const scenes = [scene("a", true), scene("b", false, true)];
    expect(playbackTargetScene(scenes, "b")?.id).toBe("b");
  });

  it("replays the scene on screen when the selection can neither show nor open", () => {
    const scenes = [scene("a", true), scene("b")];
    expect(playbackTargetScene(scenes, "b")?.id).toBe("a");
  });

  it("falls back to the selected scene when none is on screen", () => {
    const scenes = [scene("a"), scene("b")];
    expect(playbackTargetScene(scenes, "b")?.id).toBe("b");
  });

  it("uses the scene on screen when nothing is selected", () => {
    const scenes = [scene("a"), scene("b", true)];
    expect(playbackTargetScene(scenes, undefined)?.id).toBe("b");
  });

  it("ignores a selection that no longer exists", () => {
    const scenes = [scene("a", true)];
    expect(playbackTargetScene(scenes, "gone")?.id).toBe("a");
  });

  it("returns undefined for an empty list", () => {
    expect(playbackTargetScene([], "a")).toBeUndefined();
    expect(playbackTargetScene([], undefined)).toBeUndefined();
  });
});
