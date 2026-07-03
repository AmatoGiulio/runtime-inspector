import { describe, expect, it } from "vitest";
import type {
  BezierControl,
  ColorControl,
  SliderControl,
  SpringControl,
  ToggleControl,
  TriggerControl
} from "@runtime-inspector/protocol";

function controlById(schema: import("@runtime-inspector/protocol").PanelSchema, id: string) {
  return schema.groups[0].controls.find((control) => control.id === id);
}

/**
 * Test double for reanimated's `makeMutable` - the real module can't load in
 * this (non-RN) test environment. Injected via `options.makeMutable` so
 * `buildInspector` never hits the real "reanimated is required" throw except
 * in the dedicated test for that behavior.
 */
function fakeMakeMutable<T>(value: T) {
  return { value };
}

describe("deriveLabel", () => {
  it("splits camelCase and capitalizes the first letter", async () => {
    const { deriveLabel } = await import("./use-inspector");
    expect(deriveLabel("moveX")).toBe("Move X");
    expect(deriveLabel("opacity")).toBe("Opacity");
    expect(deriveLabel("backdropColor")).toBe("Backdrop Color");
  });
});

describe("buildInspector - control inference", () => {
  it("infers a slider from { value, min, max }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { moveX: { value: 0, min: -120, max: 120, step: 1, unit: "px" } },
      { makeMutable: fakeMakeMutable }
    );

    const control = controlById(schema, "moveX") as SliderControl;
    expect(control.kind).toBe("slider");
    expect(control.label).toBe("Move X");
    expect(control.min).toBe(-120);
    expect(control.max).toBe(120);
    expect(control.step).toBe(1);
    expect(control.unit).toBe("px");
    expect(control.defaultValue).toBe(0);
    expect(control.binding).toBe("panel.moveX");
    expect(handles.moveX.value).toBe(0);
  });

  it("respects an explicit label on object forms", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema } = buildInspector(
      "panel",
      { moveX: { value: 0, min: -1, max: 1, label: "Custom Label" } },
      { makeMutable: fakeMakeMutable }
    );
    expect(controlById(schema, "moveX")?.label).toBe("Custom Label");
  });

  it("infers a toggle from a boolean", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", { enabled: true }, { makeMutable: fakeMakeMutable });
    const control = controlById(schema, "enabled") as ToggleControl;
    expect(control.kind).toBe("toggle");
    expect(control.label).toBe("Enabled");
    expect(control.defaultValue).toBe(true);
    expect(handles.enabled.value).toBe(true);
  });

  it("infers a color from a string", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", { cardColor: "#f5f7fb" }, { makeMutable: fakeMakeMutable });
    const control = controlById(schema, "cardColor") as ColorControl;
    expect(control.kind).toBe("color");
    expect(control.label).toBe("Card Color");
    expect(control.defaultValue).toBe("#f5f7fb");
    expect(handles.cardColor.value).toBe("#f5f7fb");
  });

  it("infers a spring from an object with numeric damping/stiffness", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { spring: { damping: 14, stiffness: 180, mass: 1 } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "spring") as SpringControl;
    expect(control.kind).toBe("spring");
    expect(control.label).toBe("Spring");
    expect(control.defaultValue).toEqual({ damping: 14, stiffness: 180, mass: 1 });
    expect(handles.spring.value).toEqual({ damping: 14, stiffness: 180, mass: 1 });
  });

  it("infers a bezier from an array of 4 numbers", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { easing: [0.22, 1, 0.36, 1] },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "easing") as BezierControl;
    expect(control.kind).toBe("bezier");
    expect(control.label).toBe("Easing");
    expect(control.defaultValue).toEqual([0.22, 1, 0.36, 1]);
    expect(handles.easing.value).toEqual([0.22, 1, 0.36, 1]);
  });

  it("infers a trigger from a function and returns it as-is", async () => {
    const { buildInspector } = await import("./use-inspector");
    const fn = () => {};
    const { schema, handles } = buildInspector("panel", { replay: fn }, { makeMutable: fakeMakeMutable });
    const control = controlById(schema, "replay") as TriggerControl;
    expect(control.kind).toBe("trigger");
    expect(control.label).toBe("Replay");
    expect(handles.replay).toBe(fn);
  });

  it("throws a descriptive error for a bare number", async () => {
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { moveX: 5 as never })).toThrow(
      /explicit range|value, min, max/i
    );
  });

  it("throws for a bezier array of the wrong length", async () => {
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { easing: [0.1, 0.2, 0.3] as never })).toThrow(
      /exactly 4 numbers/i
    );
  });

  it("throws for an unrecognized spec shape", async () => {
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { weird: null as never })).toThrow(
      /could not infer a control kind/i
    );
  });

  it("throws for a spec key starting with $", async () => {
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { $reserved: true as never })).toThrow(/reserved/i);
  });
});

describe("buildInspector - wrapped entry form", () => {
  it("infers a toggle from a wrapped { value: boolean }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { enabled: { value: true, label: "On/Off" } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "enabled") as ToggleControl;
    expect(control.kind).toBe("toggle");
    expect(control.label).toBe("On/Off");
    expect(control.defaultValue).toBe(true);
    expect(handles.enabled.value).toBe(true);
  });

  it("infers a color from a wrapped { value: string }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { cardColor: { value: "#f5f7fb" } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "cardColor") as ColorControl;
    expect(control.kind).toBe("color");
    expect(control.defaultValue).toBe("#f5f7fb");
    expect(handles.cardColor.value).toBe("#f5f7fb");
  });

  it("infers a spring from a wrapped { value: SpringValue }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { spring: { value: { damping: 14, stiffness: 180 } } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "spring") as SpringControl;
    expect(control.kind).toBe("spring");
    expect(control.defaultValue).toEqual({ damping: 14, stiffness: 180 });
    expect(handles.spring.value).toEqual({ damping: 14, stiffness: 180 });
  });

  it("infers a bezier from a wrapped { value: CubicBezier }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { easing: { value: [0.22, 1, 0.36, 1] } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "easing") as BezierControl;
    expect(control.kind).toBe("bezier");
    expect(control.defaultValue).toEqual([0.22, 1, 0.36, 1]);
    expect(handles.easing.value).toEqual([0.22, 1, 0.36, 1]);
  });

  it("infers a slider from a wrapped { value: number, min, max }", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector(
      "panel",
      { moveX: { value: 0, min: -10, max: 10 } },
      { makeMutable: fakeMakeMutable }
    );
    const control = controlById(schema, "moveX") as SliderControl;
    expect(control.kind).toBe("slider");
    expect(handles.moveX.value).toBe(0);
  });

  it("throws for a wrapped number without min/max", async () => {
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { moveX: { value: 5 } as never })).toThrow(
      /explicit range|value, min, max/i
    );
  });
});

describe("buildInspector - $targets", () => {
  it("initializes $targets to each value control's default, with no trigger keys", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { handles } = buildInspector(
      "panel",
      {
        moveX: { value: 0, min: -10, max: 10 },
        enabled: true,
        replay: () => {}
      },
      { makeMutable: fakeMakeMutable }
    );
    expect(handles.$targets).toEqual({ moveX: 0, enabled: true });
  });

  it("updates $targets and fires onChange when a control patch is applied, handle write happens first", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { applyControlPatch, definePanel } = await import("./index");

    const order: string[] = [];
    let onChangeValue: number | undefined;
    const { schema, handles } = buildInspector(
      "panel-targets",
      {
        moveX: {
          value: 0,
          min: -10,
          max: 10,
          onChange: (v: number) => {
            order.push("onChange");
            onChangeValue = v;
          }
        }
      },
      { makeMutable: fakeMakeMutable }
    );
    definePanel(schema);

    applyControlPatch({
      type: "control.patch",
      schemaId: "panel-targets",
      controlId: "moveX",
      value: 5
    });

    expect(handles.moveX.value).toBe(5);
    expect(handles.$targets.moveX).toBe(5);
    expect(onChangeValue).toBe(5);
    expect(order).toEqual(["onChange"]);
  });

  it("writes the handle before invoking onChange (observable ordering)", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { applyControlPatch, definePanel } = await import("./index");

    let handleValueDuringOnChange: boolean | undefined;
    const { schema, handles } = buildInspector(
      "panel-order",
      {
        enabled: {
          value: false,
          onChange: () => {
            handleValueDuringOnChange = handles.enabled.value as boolean;
          }
        }
      },
      { makeMutable: fakeMakeMutable }
    );
    definePanel(schema);

    applyControlPatch({
      type: "control.patch",
      schemaId: "panel-order",
      controlId: "enabled",
      value: true
    });

    expect(handleValueDuringOnChange).toBe(true);
  });
});

describe("defaultMakeMutable - reanimated required", () => {
  it("throws an actionable error when react-native-reanimated's makeMutable is unavailable", async () => {
    // The test environment has no react-native-reanimated installed, so the
    // guarded `require` in `loadMakeMutable` fails and `defaultMakeMutable`
    // must throw rather than silently falling back to a plain object.
    const { buildInspector } = await import("./use-inspector");
    expect(() => buildInspector("panel", { enabled: true })).toThrow(
      /react-native-reanimated is required/i
    );
  });
});

describe("buildInspector - handles and bindings", () => {
  it("returns mutable handles settable like a SharedValue", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { handles } = buildInspector(
      "panel",
      { scale: { value: 1, min: 0.5, max: 2 } },
      { makeMutable: fakeMakeMutable }
    );
    handles.scale.value = 1.5;
    expect(handles.scale.value).toBe(1.5);
  });

  it("registers bindings so applyControlPatch reaches the handle", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { applyControlPatch, definePanel } = await import("./index");

    const { schema, handles } = buildInspector(
      "panel-bind",
      { scale: { value: 1, min: 0.5, max: 2 } },
      { makeMutable: fakeMakeMutable }
    );
    definePanel(schema);

    applyControlPatch({
      type: "control.patch",
      schemaId: "panel-bind",
      controlId: "scale",
      value: 1.75
    });

    expect(handles.scale.value).toBe(1.75);
  });

  it("registers trigger bindings so applyControlTrigger invokes the handler", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { applyControlTrigger, definePanel } = await import("./index");

    let called = false;
    const { schema } = buildInspector("panel-trigger-bind", {
      replay: () => {
        called = true;
      }
    });
    definePanel(schema);

    applyControlTrigger({
      type: "control.trigger",
      schemaId: "panel-trigger-bind",
      controlId: "replay"
    });

    expect(called).toBe(true);
  });

  it("builds a single group titled 'controls' with the schema title defaulting to id", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema } = buildInspector("my-panel", { enabled: true }, { makeMutable: fakeMakeMutable });
    expect(schema.id).toBe("my-panel");
    expect(schema.title).toBe("my-panel");
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0].id).toBe("controls");
  });

  it("uses an explicit title option over the id", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema } = buildInspector(
      "my-panel",
      { enabled: true },
      { title: "My Panel", makeMutable: fakeMakeMutable }
    );
    expect(schema.title).toBe("My Panel");
  });
});
