import { describe, expect, it } from "vitest";
import {
  PanelSchemaSchema,
  RIP_VERSION,
  createPatch,
  describeInvalidValue,
  isValidControlValue,
  parseRIPMessage,
  safeParseRIPMessage,
  serializeValueExpression,
  validateControlValue,
  type InspectorControl,
  type SliderControl
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

  it("rejects non-finite numeric schema fields", () => {
    const schema = {
      id: "bad-numbers",
      title: "Bad Numbers",
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
              max: Number.POSITIVE_INFINITY,
              defaultValue: 1
            }
          ]
        }
      ]
    };

    expect(() => PanelSchemaSchema.parse(schema)).toThrow();
  });

  it("rejects non-finite spring and bezier defaults in schemas", () => {
    expect(() =>
      PanelSchemaSchema.parse({
        id: "bad-spring",
        title: "Bad Spring",
        groups: [
          {
            id: "motion",
            label: "Motion",
            controls: [
              {
                id: "spring",
                kind: "spring",
                label: "Spring",
                defaultValue: { damping: 10, stiffness: Number.NaN }
              }
            ]
          }
        ]
      })
    ).toThrow();

    expect(() =>
      PanelSchemaSchema.parse({
        id: "bad-bezier",
        title: "Bad Bezier",
        groups: [
          {
            id: "motion",
            label: "Motion",
            controls: [
              {
                id: "curve",
                kind: "bezier",
                label: "Curve",
                defaultValue: [0, 0, 1, Number.POSITIVE_INFINITY]
              }
            ]
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

  it("accepts slider values in-range and at bounds, rejects out-of-range", () => {
    const control = makeControl("slider") as SliderControl;
    expect(isValidControlValue(control, 0.5)).toBe(true);
    expect(isValidControlValue(control, control.min)).toBe(true);
    expect(isValidControlValue(control, control.max)).toBe(true);
    expect(isValidControlValue(control, control.min - 0.001)).toBe(false);
    expect(isValidControlValue(control, control.max + 0.001)).toBe(false);
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

describe("describeInvalidValue", () => {
  it("describes an out-of-range slider value with its bounds", () => {
    const control: SliderControl = {
      id: "scale",
      kind: "slider",
      label: "Scale",
      defaultValue: 1,
      min: 0.5,
      max: 2
    };
    expect(describeInvalidValue(control, 9999)).toBe(
      'slider "scale" expects a finite number between 0.5 and 2, got 9999'
    );
  });

  it("describes a wrong-type toggle value", () => {
    const control = makeControl("toggle");
    expect(describeInvalidValue(control, "true")).toBe(
      'toggle "toggle" expects a boolean, got string'
    );
  });
});

describe("validateControlValue", () => {
  it("returns ok: true for a valid value", () => {
    const control = makeControl("toggle");
    expect(validateControlValue(control, true)).toEqual({ ok: true });
  });

  it("flags an out-of-range slider value with OUT_OF_RANGE", () => {
    const control = makeControl("slider") as SliderControl;
    const result = validateControlValue(control, control.max + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("OUT_OF_RANGE");
  });

  // A NaN slider value fails the finite-number check before range comparison
  // is even possible, so it is treated as a type mismatch (WRONG_TYPE) rather
  // than MALFORMED_VALUE - the value isn't the right shape at all.
  it("flags a NaN slider value with WRONG_TYPE", () => {
    const control = makeControl("slider");
    const result = validateControlValue(control, Number.NaN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_TYPE");
  });

  it("flags a string toggle value with WRONG_TYPE", () => {
    const control = makeControl("toggle");
    const result = validateControlValue(control, "true");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("WRONG_TYPE");
  });

  // A 3-element array is still "array-shaped" (the right general shape for
  // bezier), just the wrong length - per spec this is MALFORMED_VALUE, not
  // WRONG_TYPE. WRONG_TYPE is reserved for values that aren't even an array.
  it("flags a 3-element bezier array with MALFORMED_VALUE", () => {
    const control = makeControl("bezier");
    const result = validateControlValue(control, [0.1, 0.2, 0.3]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_VALUE");
  });

  it("flags a bezier array with a non-finite element with MALFORMED_VALUE", () => {
    const control = makeControl("bezier");
    const result = validateControlValue(control, [0, 0, 1, Number.POSITIVE_INFINITY]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_VALUE");
  });

  it("flags a spring value missing stiffness with MALFORMED_VALUE", () => {
    const control = makeControl("spring");
    const result = validateControlValue(control, { damping: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_VALUE");
  });

  it("flags an unknown control kind with UNKNOWN_KIND", () => {
    const control = { id: "x", kind: "unknown", label: "x" } as unknown as InspectorControl;
    const result = validateControlValue(control, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNKNOWN_KIND");
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

  it("parses a valid control.patch with an extra unknown field (tolerant reader)", () => {
    const json = JSON.stringify({
      ...createPatch("schema", "scale", 1.1),
      futureField: "some-value-from-a-newer-client"
    });
    const message = safeParseRIPMessage(json);
    expect(message?.type).toBe("control.patch");
  });

  it("returns undefined for a message with an unknown type", () => {
    const json = JSON.stringify({ type: "control.teleport", schemaId: "s", controlId: "c", value: 1 });
    expect(safeParseRIPMessage(json)).toBeUndefined();
  });
});

describe("serializeValueExpression", () => {
  it("serializes a slider/number value as a numeric literal", () => {
    expect(serializeValueExpression("slider", 42)).toBe("42");
    expect(serializeValueExpression("slider", -0.5)).toBe("-0.5");
  });

  it("serializes a toggle value as true/false", () => {
    expect(serializeValueExpression("toggle", true)).toBe("true");
    expect(serializeValueExpression("toggle", false)).toBe("false");
  });

  it("serializes a color value as a double-quoted string", () => {
    expect(serializeValueExpression("color", "#ff0000")).toBe('"#ff0000"');
  });

  it("serializes a bezier value as a 4-element array literal", () => {
    expect(serializeValueExpression("bezier", [0.4, 0, 0.2, 1])).toBe("[0.4, 0, 0.2, 1]");
  });

  it("serializes a spring value without mass", () => {
    expect(serializeValueExpression("spring", { damping: 10, stiffness: 100 })).toBe(
      "{ damping: 10, stiffness: 100 }"
    );
  });

  it("serializes a spring value with mass", () => {
    expect(serializeValueExpression("spring", { damping: 10, stiffness: 100, mass: 1.5 })).toBe(
      "{ damping: 10, stiffness: 100, mass: 1.5 }"
    );
  });

  it("throws for a trigger kind", () => {
    expect(() => serializeValueExpression("trigger", undefined)).toThrow(/trigger/i);
  });

  it("throws for a slider value that is not a finite number", () => {
    expect(() => serializeValueExpression("slider", "not-a-number")).toThrow(/slider/i);
  });

  it("throws for a toggle value that is not a boolean", () => {
    expect(() => serializeValueExpression("toggle", "true")).toThrow(/toggle/i);
  });

  it("throws for a color value that is not a string", () => {
    expect(() => serializeValueExpression("color", 123)).toThrow(/color/i);
  });

  it("throws for a bezier value with the wrong shape", () => {
    expect(() => serializeValueExpression("bezier", [0, 0, 1])).toThrow(/bezier/i);
  });

  it("throws for a spring value missing required fields", () => {
    expect(() => serializeValueExpression("spring", { damping: 10 })).toThrow(/spring/i);
  });
});

describe("runtime animation observation protocol", () => {
  it("parses automatic animation lifecycle messages", () => {
    expect(
      parseRIPMessage({
        type: "animation.started",
        instanceId: "anim-1",
        callsiteId: "src/Card.tsx:20:4:timing:card.moveX",
        schemaId: "card-transition",
        target: "card.moveX",
        animationKind: "timing",
        startedAtRuntimeMs: 1000,
        toValue: -110,
        config: { duration: 260 },
        source: {
          file: "src/Card.tsx",
          line: 20,
          column: 4,
          enclosure: ["Card", "replay"],
          expression: "withTiming(-110, { duration: 260 })"
        }
      }).type
    ).toBe("animation.started");

    expect(
      parseRIPMessage({
        type: "animation.completed",
        instanceId: "anim-1",
        callsiteId: "src/Card.tsx:20:4:timing:card.moveX",
        schemaId: "card-transition",
        target: "card.moveX",
        animationKind: "timing",
        endedAtRuntimeMs: 1260,
        finished: true,
        current: -110
      }).type
    ).toBe("animation.completed");
  });

  it("rejects non-finite animation timing metadata", () => {
    expect(() =>
      parseRIPMessage({
        type: "animation.started",
        instanceId: "anim-bad",
        callsiteId: "callsite",
        target: "moveX",
        animationKind: "timing",
        startedAtRuntimeMs: Number.NaN,
        config: {}
      })
    ).toThrow();
  });
});

describe("recording protocol (RFC 0005 M0)", () => {
  it("parses trace schema and recording lifecycle messages", () => {
    expect(
      parseRIPMessage({
        type: "trace.schema.publish",
        schemaId: "card-transition",
        probes: [{ id: "moveX", valueType: "number", unit: "px" }]
      }).type
    ).toBe("trace.schema.publish");

    expect(
      parseRIPMessage({
        type: "recording.start",
        recordingId: "rec-1",
        schemaId: "card-transition",
        probeIds: ["moveX"],
        sampleRateHz: 60
      }).type
    ).toBe("recording.start");

    expect(
      parseRIPMessage({
        type: "recording.chunk",
        recordingId: "rec-1",
        schemaId: "card-transition",
        sequence: 0,
        samples: [
          { t: 0, values: { moveX: 0 } },
          { t: 16.67, values: { moveX: -12.5 } }
        ]
      }).type
    ).toBe("recording.chunk");
  });

  it("rejects unsupported M0 sampling rates and non-finite samples", () => {
    expect(() =>
      parseRIPMessage({
        type: "recording.start",
        recordingId: "rec-fast",
        schemaId: "card-transition",
        probeIds: ["moveX"],
        sampleRateHz: 120
      })
    ).toThrow();

    expect(() =>
      parseRIPMessage({
        type: "recording.chunk",
        recordingId: "rec-1",
        schemaId: "card-transition",
        sequence: 0,
        samples: [{ t: 0, values: { moveX: Number.NaN } }]
      })
    ).toThrow();
  });
});