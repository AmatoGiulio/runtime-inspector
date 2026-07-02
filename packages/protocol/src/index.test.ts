import { describe, expect, it } from "vitest";
import {
  PanelSchemaSchema,
  RIP_VERSION,
  createPatch,
  isValidControlValue,
  parseRIPMessage,
  safeParseRIPMessage,
  type InspectorControl
} from "./index";

describe("Runtime Inspector Protocol", () => {
  it("parses a valid slider schema", () => {
    const schema = PanelSchemaSchema.parse({
      id: "card-transition",
      title: "Card Transition",
      groups: [
        {
          id: "motion",
          label: "Motion",
          controls: [
            {
              id: "scale",
              kind: "slider",
              label: "Scale",
              min: 0,
              max: 2,
              defaultValue: 1
            }
          ]
        }
      ]
    });

    expect(schema.groups[0]?.controls[0]?.kind).toBe("slider");
  });

  it("rejects an invalid control kind", () => {
    expect(() =>
      PanelSchemaSchema.parse({
        id: "bad",
        title: "Bad",
        groups: [
          {
            id: "bad",
            label: "Bad",
            controls: [{ id: "bad", kind: "unknown", label: "Bad" }]
          }
        ]
      })
    ).toThrow();
  });

  it("parses handshake and patch messages", () => {
    const hello = parseRIPMessage({
      type: "handshake.hello",
      protocolVersion: RIP_VERSION,
      role: "panel",
      clientId: "panel-test"
    });
    const patch = parseRIPMessage(createPatch("schema", "scale", 1.1));

    expect(hello.type).toBe("handshake.hello");
    expect(patch.type).toBe("control.patch");
  });
});

function makeControl(kind: InspectorControl["kind"]): InspectorControl {
  const base = { id: kind, label: kind };
  switch (kind) {
    case "slider":
      return { ...base, kind: "slider", defaultValue: 0, min: 0, max: 1 };
    case "toggle":
      return { ...base, kind: "toggle", defaultValue: false };
    case "color":
      return { ...base, kind: "color", defaultValue: "#000000" };
    case "bezier":
      return { ...base, kind: "bezier", defaultValue: [0, 0, 1, 1] };
    case "spring":
      return { ...base, kind: "spring", defaultValue: { damping: 10, stiffness: 100 } };
    case "trigger":
      return { ...base, kind: "trigger" };
    default:
      throw new Error(`Unhandled kind: ${kind}`);
  }
}

describe("isValidControlValue", () => {
  it("accepts a finite number for slider and rejects NaN", () => {
    const control = makeControl("slider");
    expect(isValidControlValue(control, 0.5)).toBe(true);
    expect(isValidControlValue(control, Number.NaN)).toBe(false);
  });

  it("accepts a boolean for toggle and rejects a string", () => {
    const control = makeControl("toggle");
    expect(isValidControlValue(control, true)).toBe(true);
    expect(isValidControlValue(control, "true")).toBe(false);
  });

  it("accepts a string for color and rejects a number", () => {
    const control = makeControl("color");
    expect(isValidControlValue(control, "#ffffff")).toBe(true);
    expect(isValidControlValue(control, 16777215)).toBe(false);
  });

  it("accepts a 4-tuple of finite numbers for bezier and rejects a 3-element array", () => {
    const control = makeControl("bezier");
    expect(isValidControlValue(control, [0.1, 0.2, 0.3, 0.4])).toBe(true);
    expect(isValidControlValue(control, [0.1, 0.2, 0.3])).toBe(false);
  });

  it("accepts a valid spring value and rejects one missing stiffness", () => {
    const control = makeControl("spring");
    expect(isValidControlValue(control, { damping: 10, stiffness: 100 })).toBe(true);
    expect(isValidControlValue(control, { damping: 10 })).toBe(false);
  });

  it("rejects a spring value with a non-finite mass", () => {
    const control = makeControl("spring");
    expect(
      isValidControlValue(control, { damping: 10, stiffness: 100, mass: Number.POSITIVE_INFINITY })
    ).toBe(false);
  });

  it("accepts any value for trigger", () => {
    const control = makeControl("trigger");
    expect(isValidControlValue(control, { anything: "goes" })).toBe(true);
  });

  it("rejects an unknown control kind", () => {
    const control = { id: "x", kind: "unknown", label: "x" } as unknown as InspectorControl;
    expect(isValidControlValue(control, 1)).toBe(false);
  });
});

describe("safeParseRIPMessage", () => {
  it("parses a valid patch JSON string", () => {
    const json = JSON.stringify(createPatch("schema", "scale", 1.1));
    const message = safeParseRIPMessage(json);
    expect(message?.type).toBe("control.patch");
  });

  it("returns undefined for a garbage string", () => {
    expect(safeParseRIPMessage("not json")).toBeUndefined();
  });

  it("returns undefined for a garbage object", () => {
    expect(safeParseRIPMessage({ not: "valid" })).toBeUndefined();
  });
});
