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
    const { schema, handles } = buildInspector("panel", {
      moveX: { value: 0, min: -120, max: 120, step: 1, unit: "px" }
    });

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
    const { schema } = buildInspector("panel", {
      moveX: { value: 0, min: -1, max: 1, label: "Custom Label" }
    });
    expect(controlById(schema, "moveX")?.label).toBe("Custom Label");
  });

  it("infers a toggle from a boolean", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", { enabled: true });
    const control = controlById(schema, "enabled") as ToggleControl;
    expect(control.kind).toBe("toggle");
    expect(control.label).toBe("Enabled");
    expect(control.defaultValue).toBe(true);
    expect(handles.enabled.value).toBe(true);
  });

  it("infers a color from a string", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", { cardColor: "#f5f7fb" });
    const control = controlById(schema, "cardColor") as ColorControl;
    expect(control.kind).toBe("color");
    expect(control.label).toBe("Card Color");
    expect(control.defaultValue).toBe("#f5f7fb");
    expect(handles.cardColor.value).toBe("#f5f7fb");
  });

  it("infers a spring from an object with numeric damping/stiffness", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", {
      spring: { damping: 14, stiffness: 180, mass: 1 }
    });
    const control = controlById(schema, "spring") as SpringControl;
    expect(control.kind).toBe("spring");
    expect(control.label).toBe("Spring");
    expect(control.defaultValue).toEqual({ damping: 14, stiffness: 180, mass: 1 });
    expect(handles.spring.value).toEqual({ damping: 14, stiffness: 180, mass: 1 });
  });

  it("infers a bezier from an array of 4 numbers", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema, handles } = buildInspector("panel", {
      easing: [0.22, 1, 0.36, 1]
    });
    const control = controlById(schema, "easing") as BezierControl;
    expect(control.kind).toBe("bezier");
    expect(control.label).toBe("Easing");
    expect(control.defaultValue).toEqual([0.22, 1, 0.36, 1]);
    expect(handles.easing.value).toEqual([0.22, 1, 0.36, 1]);
  });

  it("infers a trigger from a function and returns it as-is", async () => {
    const { buildInspector } = await import("./use-inspector");
    const fn = () => {};
    const { schema, handles } = buildInspector("panel", { replay: fn });
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
});

describe("buildInspector - handles and bindings", () => {
  it("returns mutable handles settable like a SharedValue", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { handles } = buildInspector("panel", { scale: { value: 1, min: 0.5, max: 2 } });
    handles.scale.value = 1.5;
    expect(handles.scale.value).toBe(1.5);
  });

  it("registers bindings so applyControlPatch reaches the handle", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { applyControlPatch, definePanel } = await import("./index");

    const { schema, handles } = buildInspector("panel-bind", {
      scale: { value: 1, min: 0.5, max: 2 }
    });
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
    const { schema } = buildInspector("my-panel", { enabled: true });
    expect(schema.id).toBe("my-panel");
    expect(schema.title).toBe("my-panel");
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0].id).toBe("controls");
  });

  it("uses an explicit title option over the id", async () => {
    const { buildInspector } = await import("./use-inspector");
    const { schema } = buildInspector("my-panel", { enabled: true }, { title: "My Panel" });
    expect(schema.title).toBe("My Panel");
  });
});
