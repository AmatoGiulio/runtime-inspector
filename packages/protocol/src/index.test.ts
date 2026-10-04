import { describe, expect, it } from "vitest";
import {
  PanelSchemaSchema,
  RIP_VERSION,
  SCENES_SCHEMA_ID,
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
        configControlId: "spring",
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

  const timingStarted = {
    type: "animation.started",
    instanceId: "anim-2",
    callsiteId: "App.tsx:74:4:timing:card.moveX",
    schemaId: "card-transition",
    target: "card.moveX",
    animationKind: "timing",
    startedAtRuntimeMs: 1000,
    config: { duration: 260 }
  };

  it("parses and round-trips parameterControls on animation.started", () => {
    const parameterControls = {
      duration: {
        schemaId: "auto",
        controlId: "App.tsx:74:4:timing:card.moveX:duration"
      }
    };
    const parsed = parseRIPMessage({ ...timingStarted, parameterControls });

    expect(parsed.type).toBe("animation.started");
    if (parsed.type !== "animation.started") throw new Error("unexpected message type");
    expect(parsed.parameterControls).toEqual(parameterControls);

    const roundTripped = safeParseRIPMessage(JSON.stringify(parsed));
    expect(roundTripped).toEqual(parsed);
  });

  it("rejects a parameterControls entry with an empty controlId", () => {
    expect(() =>
      parseRIPMessage({
        ...timingStarted,
        parameterControls: { duration: { schemaId: "auto", controlId: "" } }
      })
    ).toThrow();
  });

  it("still parses animation.started without parameterControls", () => {
    const parsed = parseRIPMessage(timingStarted);
    expect(parsed.type).toBe("animation.started");
    expect("parameterControls" in parsed).toBe(false);
  });

  const startControl = {
    schemaId: "auto",
    controlId: "App.tsx:74:4:timing:card.moveX:delay"
  };

  it("parses and round-trips startControl and startDelayMs on animation.started", () => {
    const parsed = parseRIPMessage({ ...timingStarted, startControl, startDelayMs: 120 });

    expect(parsed.type).toBe("animation.started");
    if (parsed.type !== "animation.started") throw new Error("unexpected message type");
    expect(parsed.startControl).toEqual(startControl);
    expect(parsed.startDelayMs).toBe(120);

    const roundTripped = safeParseRIPMessage(JSON.stringify(parsed));
    expect(roundTripped).toEqual(parsed);
  });

  it("accepts a zero startDelayMs and omits both start fields when absent", () => {
    const zero = parseRIPMessage({ ...timingStarted, startDelayMs: 0 });
    if (zero.type !== "animation.started") throw new Error("unexpected message type");
    expect(zero.startDelayMs).toBe(0);

    const plain = parseRIPMessage(timingStarted);
    expect("startControl" in plain).toBe(false);
    expect("startDelayMs" in plain).toBe(false);
  });

  it("rejects a negative startDelayMs", () => {
    expect(() => parseRIPMessage({ ...timingStarted, startDelayMs: -1 })).toThrow();
    expect(safeParseRIPMessage(JSON.stringify({ ...timingStarted, startDelayMs: -1 }))).toBeUndefined();
  });

  it("rejects a startControl with an empty controlId", () => {
    expect(() =>
      parseRIPMessage({
        ...timingStarted,
        startControl: { schemaId: "auto", controlId: "" }
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
describe("scenes protocol (RFC 0006)", () => {
  const sceneTrigger = {
    id: "product-reveal",
    kind: "trigger",
    label: "Product reveal",
    binding: "scenes.product-reveal",
    scene: { url: "myapp://product", active: true, reachable: true }
  };

  function scenesPublish(control: Record<string, unknown>) {
    return {
      type: "schema.publish",
      schema: {
        id: SCENES_SCHEMA_ID,
        title: "Scenes",
        groups: [{ id: "Store", label: "Store", controls: [control] }]
      }
    };
  }

  it("reserves the scenes schema id", () => {
    expect(SCENES_SCHEMA_ID).toBe("scenes");
  });

  it("keeps the scene field on a trigger through parse and round-trip", () => {
    const parsed = parseRIPMessage(scenesPublish(sceneTrigger));
    if (parsed.type !== "schema.publish") throw new Error("unexpected message type");
    expect(parsed.schema.groups[0]?.controls[0]).toEqual(sceneTrigger);
    expect(safeParseRIPMessage(JSON.stringify(parsed))).toEqual(parsed);
  });

  it("accepts a scene without url and a trigger without scene", () => {
    expect(() =>
      parseRIPMessage(scenesPublish({ ...sceneTrigger, scene: { active: false, reachable: false } }))
    ).not.toThrow();
    const { scene: _scene, ...plain } = sceneTrigger;
    const parsed = parseRIPMessage(scenesPublish(plain));
    if (parsed.type !== "schema.publish") throw new Error("unexpected message type");
    expect("scene" in parsed.schema.groups[0]!.controls[0]!).toBe(false);
  });

  it("rejects a scene without active or reachable, or with an empty url", () => {
    for (const scene of [
      { url: "myapp://product", reachable: true },
      { url: "myapp://product", active: true },
      { url: "", active: true, reachable: true },
      { active: "yes", reachable: true }
    ]) {
      expect(() => parseRIPMessage(scenesPublish({ ...sceneTrigger, scene }))).toThrow();
      expect(safeParseRIPMessage(JSON.stringify(scenesPublish({ ...sceneTrigger, scene })))).toBeUndefined();
    }
  });

  const navigating = {
    type: "scene.status",
    sceneId: "product-reveal",
    phase: "navigating",
    atRuntimeMs: 1200.5
  };
  const failed = {
    ...navigating,
    phase: "failed",
    code: "MOUNT_TIMEOUT",
    reason: "No useScene(\"product-reveal\") became active within 5000 ms."
  };

  it("parses every scene.status phase", () => {
    expect(parseRIPMessage(navigating)).toEqual(navigating);
    expect(parseRIPMessage({ ...navigating, phase: "playing", atRuntimeMs: 0 }).type).toBe("scene.status");
    expect(parseRIPMessage(failed)).toEqual(failed);
    expect(safeParseRIPMessage(JSON.stringify(failed))).toEqual(failed);
    for (const code of ["UNREACHABLE", "NAVIGATION_FAILED", "MOUNT_TIMEOUT", "PLAY_FAILED", "SUPERSEDED"]) {
      expect(parseRIPMessage({ ...failed, code }).type).toBe("scene.status");
    }
  });

  it("rejects a failed scene.status without a code or without a reason", () => {
    const { code: _code, ...withoutCode } = failed;
    const { reason: _reason, ...withoutReason } = failed;
    for (const message of [withoutCode, withoutReason]) {
      expect(() => parseRIPMessage(message)).toThrow();
      expect(safeParseRIPMessage(JSON.stringify(message))).toBeUndefined();
    }
  });

  it("rejects a code or a reason on a phase other than failed", () => {
    for (const message of [
      { ...navigating, code: "MOUNT_TIMEOUT" },
      { ...navigating, phase: "playing", reason: "played" },
      { ...navigating, phase: "playing", code: "PLAY_FAILED", reason: "boom" }
    ]) {
      expect(() => parseRIPMessage(message)).toThrow();
      expect(safeParseRIPMessage(JSON.stringify(message))).toBeUndefined();
    }
  });

  it("rejects unknown phases and codes and malformed fields", () => {
    for (const message of [
      { ...navigating, phase: "teleporting" },
      { ...failed, code: "TOTALLY_MADE_UP" },
      { ...failed, reason: "" },
      { ...navigating, sceneId: "" },
      { ...navigating, atRuntimeMs: -1 },
      { ...navigating, atRuntimeMs: Number.NaN }
    ]) {
      expect(() => parseRIPMessage(message)).toThrow();
    }
  });
});

describe("animation literal anchors (RFC 0007)", () => {
  const literal = {
    file: "src/WelcomeDemo.tsx",
    line: 41,
    column: 4,
    enclosure: ["WelcomeDemo", "play"],
    target: "titleY.value",
    callee: "withTiming",
    parameter: "duration",
    init: "380"
  } as const;

  function literalRequest(overrides: Record<string, unknown> = {}) {
    return {
      type: "source.apply",
      schemaId: "auto",
      requests: [
        {
          controlId: "src/WelcomeDemo.tsx:41:4:timing:titleY:duration",
          kind: "slider",
          value: 420,
          literal,
          ...overrides
        }
      ]
    };
  }

  it("keeps literal on a slider control through parse", () => {
    const schema = PanelSchemaSchema.parse({
      id: "auto",
      title: "Animations",
      groups: [
        {
          id: "animations",
          label: "Animations",
          controls: [
            {
              id: "duration",
              kind: "slider",
              label: "Duration",
              defaultValue: 380,
              min: 0,
              max: 2000,
              literal
            }
          ]
        }
      ]
    });
    expect(schema.groups[0].controls[0]).toMatchObject({ literal });
  });

  it("accepts a literal request, including a bare-call delay with init null", () => {
    expect(() => parseRIPMessage(literalRequest())).not.toThrow();
    expect(() =>
      parseRIPMessage(literalRequest({ literal: { ...literal, parameter: "delay", init: null } }))
    ).not.toThrow();
  });

  it("rejects a literal request whose value is not a finite number", () => {
    expect(() => parseRIPMessage(literalRequest({ value: Number.NaN }))).toThrow();
    expect(() => parseRIPMessage(literalRequest({ value: "420" }))).toThrow();
    expect(safeParseRIPMessage(JSON.stringify(literalRequest({ value: null })))).toBeUndefined();
  });

  it("rejects malformed literal anchors", () => {
    expect(() =>
      parseRIPMessage(literalRequest({ literal: { ...literal, callee: "withDecay" } }))
    ).toThrow();
    expect(() =>
      parseRIPMessage(literalRequest({ literal: { ...literal, parameter: "toValue" } }))
    ).toThrow();
    expect(() => parseRIPMessage(literalRequest({ literal: { ...literal, target: "" } }))).toThrow();
  });
});
