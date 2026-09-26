import { describe, expect, it } from "vitest";
import { sampleSpringCurve } from "./spring-curve";

describe("sampleSpringCurve", () => {
  it("converges to 1 for a typical underdamped spring", () => {
    // zeta = 14 / (2 * sqrt(180 * 1)) ~= 0.522 < 1
    const curve = sampleSpringCurve({ damping: 14, stiffness: 180, mass: 1 });
    const last = curve.points[curve.points.length - 1];
    expect(Math.abs(last.x - 1)).toBeLessThan(2e-3);
  });

  it("overshoots when zeta < 1", () => {
    // zeta = 5 / (2 * sqrt(300)) ~= 0.144 < 1
    const curve = sampleSpringCurve({ damping: 5, stiffness: 300 });
    const max = Math.max(...curve.points.map((p) => p.x));
    expect(max).toBeGreaterThan(1);
  });

  it("never overshoots when zeta >= 1", () => {
    // zeta = 40 / (2 * sqrt(20 * 1)) ~= 4.47 >= 1
    const curve = sampleSpringCurve({ damping: 40, stiffness: 20, mass: 1 });
    for (const point of curve.points) {
      expect(point.x).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("converges without overshoot for an overdamped spring whose settle time fits the window", () => {
    // zeta = 8 / (2 * sqrt(15)) ~= 1.033, slow pole decay = 3 rad/s, settle ~= 2.3s < 4s
    const curve = sampleSpringCurve({ damping: 8, stiffness: 15, mass: 1 });
    expect(curve.duration).toBeGreaterThan(0.25);
    expect(curve.duration).toBeLessThan(4);
    const last = curve.points[curve.points.length - 1];
    expect(Math.abs(last.x - 1)).toBeLessThan(0.005);
    for (const point of curve.points) {
      expect(point.x).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("clamps a heavily overdamped spring to 4s with a monotone curve approaching 1", () => {
    // zeta ~= 4.47, slow pole ~= 0.506 rad/s -> settle ~= 13.6s, clamped to 4s:
    // the curve legitimately does not converge inside the window.
    const curve = sampleSpringCurve({ damping: 40, stiffness: 20, mass: 1 });
    expect(curve.duration).toBe(4);
    for (let i = 1; i < curve.points.length; i += 1) {
      expect(curve.points[i].x).toBeGreaterThanOrEqual(curve.points[i - 1].x - 1e-9);
    }
    const last = curve.points[curve.points.length - 1];
    expect(last.x).toBeGreaterThan(0.5);
    expect(last.x).toBeLessThanOrEqual(1);
  });

  it("clamps duration to 4s for a very slow spring", () => {
    const curve = sampleSpringCurve({ damping: 0.001, stiffness: 0.001, mass: 1000 });
    expect(curve.duration).toBe(4);
  });

  it("clamps duration to 0.25s for a very fast spring", () => {
    const curve = sampleSpringCurve({ damping: 1000, stiffness: 100000, mass: 0.001 });
    expect(curve.duration).toBe(0.25);
  });

  it("produces no NaN/Infinity across typical extreme ranges and degenerate input", () => {
    const dampingRange = [1, 40];
    const stiffnessRange = [20, 400];
    const massRange = [0.2, 4];

    for (const damping of dampingRange) {
      for (const stiffness of stiffnessRange) {
        for (const mass of massRange) {
          const curve = sampleSpringCurve({ damping, stiffness, mass });
          for (const point of curve.points) {
            expect(Number.isFinite(point.t)).toBe(true);
            expect(Number.isFinite(point.x)).toBe(true);
          }
        }
      }
    }

    const degenerateValues = [
      { damping: 0, stiffness: 0, mass: 0 },
      { damping: -5, stiffness: -10, mass: -1 },
      { damping: Number.NaN, stiffness: Number.NaN, mass: Number.NaN }
    ];

    for (const value of degenerateValues) {
      const curve = sampleSpringCurve(value);
      expect(Number.isFinite(curve.duration)).toBe(true);
      for (const point of curve.points) {
        expect(Number.isFinite(point.t)).toBe(true);
        expect(Number.isFinite(point.x)).toBe(true);
      }
    }
  });

  it("samples 120 points by default and respects an override", () => {
    const curve = sampleSpringCurve({ damping: 14, stiffness: 180, mass: 1 });
    expect(curve.points).toHaveLength(120);

    const overridden = sampleSpringCurve({ damping: 14, stiffness: 180, mass: 1 }, { points: 40 });
    expect(overridden.points).toHaveLength(40);
  });
});
