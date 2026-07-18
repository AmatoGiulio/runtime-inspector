import { describe, expect, it } from "vitest";
import {
  BezierPreview,
  BezierRow,
  ColorRow,
  ControlRow,
  SliderRow,
  SpringParameter,
  SpringPreview,
  SpringRow,
  ToggleRow,
  TriggerRow,
  coerceBezierValue,
  coerceSpringValue
} from "./index";

describe("panel-react exports", () => {
  it("exports control row components as functions", () => {
    expect(typeof ControlRow).toBe("function");
    expect(typeof SliderRow).toBe("function");
    expect(typeof ToggleRow).toBe("function");
    expect(typeof ColorRow).toBe("function");
    expect(typeof TriggerRow).toBe("function");
    expect(typeof SpringRow).toBe("function");
    expect(typeof BezierRow).toBe("function");
    expect(typeof BezierPreview).toBe("function");
    expect(typeof SpringPreview).toBe("function");
    expect(typeof SpringParameter).toBe("function");
  });

  it("exports value coercion helpers as functions", () => {
    expect(typeof coerceSpringValue).toBe("function");
    expect(typeof coerceBezierValue).toBe("function");
  });

  it("coerces a spring value falling back to defaults for invalid input", () => {
    const fallback = { damping: 10, stiffness: 100, mass: 1 };
    expect(coerceSpringValue(null, fallback)).toEqual(fallback);
    expect(coerceSpringValue({ damping: 5 }, fallback)).toEqual({
      damping: 5,
      stiffness: 100,
      mass: 1
    });
  });

  it("coerces a bezier value falling back to defaults for invalid input", () => {
    const fallback: [number, number, number, number] = [0.1, 0.2, 0.3, 0.4];
    expect(coerceBezierValue("nope", fallback)).toEqual(fallback);
    expect(coerceBezierValue([0, 0, 1, 1], fallback)).toEqual([0, 0, 1, 1]);
  });
});
