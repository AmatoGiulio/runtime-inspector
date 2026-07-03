import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function controlById(schema: import("@runtime-inspector/protocol").PanelSchema, id: string) {
  return schema.groups[0].controls.find((control) => control.id === id);
}

describe("__riInspect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAutoRegistryForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("returns the shared value unchanged (transparent pass-through)", async () => {
    const { __riInspect } = await import("./auto");
    const sharedValue = { value: 10 };
    const result = __riInspect(sharedValue, "glow", { min: 0, max: 48 });
    expect(result).toBe(sharedValue);
  });

  it("registers a slider control and publishes after the debounce window", async () => {
    const { __riInspect } = await import("./auto");
    const { applyControlPatch } = await import("./index");

    const sharedValue = { value: 8 };
    __riInspect(sharedValue, "cardRadius", { min: 8, max: 48 });

    // Not yet published.
    await vi.advanceTimersByTimeAsync(50);

    await vi.advanceTimersByTimeAsync(60);

    applyControlPatch({
      type: "control.patch",
      schemaId: "auto",
      controlId: "cardRadius",
      value: 24
    });

    expect(sharedValue.value).toBe(24);
  });

  it("infers a slider control with the declared range", async () => {
    const { __riInspect } = await import("./auto");
    const { definePanel } = await import("./index");
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");

    const sharedValue = { value: 8 };
    __riInspect(sharedValue, "cardRadius", { min: 8, max: 48, step: 2, unit: "px", label: "Card Radius" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(definePanelSpy).toHaveBeenCalled();
    const schema = definePanelSpy.mock.calls.at(-1)![0];
    const control = controlById(schema, "cardRadius");
    expect(control?.kind).toBe("slider");
    expect((control as { min: number }).min).toBe(8);
    expect((control as { max: number }).max).toBe(48);
    expect((control as { step?: number }).step).toBe(2);
    expect((control as { unit?: string }).unit).toBe("px");
    expect(control?.label).toBe("Card Radius");
    void definePanel;
  });

  it("derives a default label from the variable name when no label is given", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    __riInspect({ value: 1 }, "moveX", { min: -10, max: 10 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "moveX")?.label).toBe("Move X");
  });

  it("infers a toggle from a boolean value with no min/max needed", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    __riInspect({ value: true }, "enabled", {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    const control = controlById(schema, "enabled");
    expect(control?.kind).toBe("toggle");
  });

  it("re-registering the same name via __riInspect overwrites silently (no suffix, no warning)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    __riInspect({ value: 1 }, "moveX", { min: 0, max: 10 });
    __riInspect({ value: 2 }, "moveX", { min: 0, max: 10 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "moveX")).toBeDefined();
    expect(controlById(schema, "moveX2")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("debounces multiple registrations within the window into a single publish", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    __riInspect({ value: 1 }, "a", { min: 0, max: 1 });
    await vi.advanceTimersByTimeAsync(50);
    __riInspect({ value: 2 }, "b", { min: 0, max: 1 });
    await vi.advanceTimersByTimeAsync(50);
    __riInspect({ value: 3 }, "c", { min: 0, max: 1 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(definePanelSpy).toHaveBeenCalledTimes(1);
    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(schema.groups[0].controls).toHaveLength(3);
  });

  it("dispose releases the base name so a later registration is not suffixed", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { registerRuntimeValue } = await import("./auto");

    const dispose = registerRuntimeValue({
      kind: "value",
      name: "moveX",
      sharedValue: { value: 1 },
      meta: { min: 0, max: 10 },
      target: 1
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    registerRuntimeValue({
      kind: "value",
      name: "moveX",
      sharedValue: { value: 2 },
      meta: { min: 0, max: 10 },
      target: 2
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "moveX")).toBeDefined();
    expect(controlById(schema, "moveX2")).toBeUndefined();
  });

  it("dispose removes the control and republishes without it", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { registerRuntimeValue } = await import("./auto");

    const dispose = registerRuntimeValue({
      kind: "value",
      name: "temp",
      sharedValue: { value: 1 },
      meta: { min: 0, max: 10 },
      target: 1
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "temp")).toBeDefined();

    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "temp")).toBeUndefined();
  });

  it("two live registrations of the same name suffix and warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { registerRuntimeValue } = await import("./auto");

    registerRuntimeValue({ kind: "value", name: "dupe", sharedValue: { value: 1 }, meta: { min: 0, max: 1 }, target: 1 });
    registerRuntimeValue({ kind: "value", name: "dupe", sharedValue: { value: 2 }, meta: { min: 0, max: 1 }, target: 2 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "dupe")).toBeDefined();
    expect(controlById(schema, "dupe2")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("registers and fires a trigger entry via applyControlTrigger", async () => {
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlTrigger, definePanel } = await import("./index");
    void definePanel;

    let fired = false;
    registerRuntimeValue({
      kind: "trigger",
      name: "replay",
      handler: () => {
        fired = true;
      }
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    applyControlTrigger({
      type: "control.trigger",
      schemaId: "auto",
      controlId: "replay"
    });

    expect(fired).toBe(true);
  });

  it("re-inspecting the same name (re-render/hot-reload) overwrites in place - one control, no warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    const sharedValue1 = { value: 8 };
    __riInspect(sharedValue1, "cardRadius", { min: 8, max: 48 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const sharedValue2 = { value: 16 };
    __riInspect(sharedValue2, "cardRadius", { min: 8, max: 48 });
    __riInspect(sharedValue2, "cardRadius", { min: 8, max: 48 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "cardRadius")).toBeDefined();
    expect(controlById(schema, "cardRadius2")).toBeUndefined();
    expect(controlById(schema, "cardRadius3")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("collides"));

    const { applyControlPatch } = await import("./index");
    applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "cardRadius", value: 32 });
    expect(sharedValue2.value).toBe(32);
    expect(sharedValue1.value).toBe(8);

    warnSpy.mockRestore();
  });

  it("__riInspect then a live useRuntimeValue claim on the same name suffixes and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect, registerRuntimeValue } = await import("./auto");

    __riInspect({ value: 1 }, "x", { min: 0, max: 10 });
    registerRuntimeValue({ kind: "value", name: "x", sharedValue: { value: 2 }, meta: { min: 0, max: 10 }, target: 2 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "x")).toBeDefined();
    expect(controlById(schema, "x2")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("a live useRuntimeValue claim then __riInspect on the same name suffixes and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect, registerRuntimeValue } = await import("./auto");

    registerRuntimeValue({ kind: "value", name: "x", sharedValue: { value: 1 }, meta: { min: 0, max: 10 }, target: 1 });
    __riInspect({ value: 2 }, "x", { min: 0, max: 10 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "x")).toBeDefined();
    expect(controlById(schema, "x2")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("is a no-op in production - returns the value unchanged and never registers", async () => {
    vi.stubGlobal("__DEV__", false);
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riInspect } = await import("./auto");

    const sharedValue = { value: 5 };
    const result = __riInspect(sharedValue, "prodValue", { min: 0, max: 10 });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(result).toBe(sharedValue);
    expect(definePanelSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

const DEBOUNCE_MS = 100;
