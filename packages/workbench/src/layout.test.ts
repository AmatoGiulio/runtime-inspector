import { describe, expect, it } from "vitest";
import { TIMELINE_HEIGHT_STORAGE_KEY, clampTimelineHeight } from "./layout";

describe("clampTimelineHeight", () => {
  it("keeps a height inside the bounds, rounded to an integer", () => {
    expect(clampTimelineHeight(320, 900)).toBe(320);
    expect(clampTimelineHeight(320.6, 900)).toBe(321);
  });

  it("never goes below 200", () => {
    expect(clampTimelineHeight(40, 900)).toBe(200);
    expect(clampTimelineHeight(-10, 900)).toBe(200);
  });

  it("leaves the stage 260px below the 44px top bar", () => {
    expect(clampTimelineHeight(5000, 900)).toBe(900 - 44 - 260);
    expect(clampTimelineHeight(596, 900)).toBe(596);
    expect(clampTimelineHeight(597, 900)).toBe(596);
  });

  it("stays at 200 on tiny viewports", () => {
    expect(clampTimelineHeight(500, 400)).toBe(200);
    expect(clampTimelineHeight(100, 0)).toBe(200);
  });

  it("falls back to the lower bound for non-finite input", () => {
    expect(clampTimelineHeight(Number.NaN, 900)).toBe(200);
    expect(clampTimelineHeight(Number.POSITIVE_INFINITY, 900)).toBe(200);
  });
});

describe("TIMELINE_HEIGHT_STORAGE_KEY", () => {
  it("is namespaced like the theme key", () => {
    expect(TIMELINE_HEIGHT_STORAGE_KEY).toBe("runtime-inspector.workbench.timeline-height");
  });
});
