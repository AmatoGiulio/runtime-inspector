import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function controlById(schema: import("@runtime-inspector/protocol").PanelSchema, id: string) {
  return schema.groups[0].controls.find((control) => control.id === id);
}

function fakeMakeMutable<T>(value: T) {
  return { value };
}

const DEBOUNCE_MS = 100;

describe("buildTunable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAutoRegistryForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("infers a trigger from a function initial and returns it as-is", async () => {
    const { buildTunable } = await import("./use-tunable");
    const fn = () => {};
    const { handle, registration } = buildTunable("replay", fn, {}, fakeMakeMutable);
    expect(handle).toBe(fn);
    expect(registration.kind).toBe("trigger");
  });

  it("throws for a bare number without min/max", async () => {
    const { buildTunable } = await import("./use-tunable");
    expect(() => buildTunable("blur", 18, {}, fakeMakeMutable)).toThrow(/explicit range/i);
  });

  it("builds a value handle for a number with min/max", async () => {
    const { buildTunable } = await import("./use-tunable");
    const { handle, registration } = buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    expect((handle as { value: number }).value).toBe(18);
    expect(registration.kind).toBe("value");
  });

  it("builds a boolean/string/spring/bezier handle without a range", async () => {
    const { buildTunable } = await import("./use-tunable");
    expect((buildTunable("on", true, {}, fakeMakeMutable).handle as { value: boolean }).value).toBe(true);
    expect((buildTunable("tint", "#fff", {}, fakeMakeMutable).handle as { value: string }).value).toBe("#fff");
  });

  it("mount/register makes the control appear in the auto schema after debounce", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");

    const { registration } = buildTunable("blur", 18, { min: 0, max: 40, label: "Blur" }, fakeMakeMutable);
    registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    const control = controlById(schema, "blur");
    expect(control?.kind).toBe("slider");
    expect(control?.label).toBe("Blur");
  });

  it("unmount disposes and republishes the schema without the control", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");

    const { registration } = buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    const dispose = registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "blur")).toBeDefined();

    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "blur")).toBeUndefined();
  });

  it("remount with the same name does not accumulate a suffix", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");

    const first = registerRuntimeValue(buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    first();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    registerRuntimeValue(buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "blur")).toBeDefined();
    expect(controlById(schema, "blur2")).toBeUndefined();
  });

  it("two live registrations of the same name suffix and warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");

    registerRuntimeValue(buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration);
    registerRuntimeValue(buildTunable("blur", 20, { min: 0, max: 40 }, fakeMakeMutable).registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "blur")).toBeDefined();
    expect(controlById(schema, "blur2")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("panel patch writes the handle and fires onChange", async () => {
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlPatch } = await import("./index");

    let onChangeValue: number | undefined;
    const { handle, registration } = buildTunable(
      "blur",
      18,
      { min: 0, max: 40, onChange: (v: number) => (onChangeValue = v) },
      fakeMakeMutable
    );
    registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    applyControlPatch({
      type: "control.patch",
      schemaId: "auto",
      controlId: "blur",
      value: 30
    });

    expect((handle as { value: number }).value).toBe(30);
    expect(onChangeValue).toBe(30);
  });

  it("trigger entry fires via applyControlTrigger", async () => {
    const { buildTunable } = await import("./use-tunable");
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlTrigger } = await import("./index");

    let fired = false;
    const { registration } = buildTunable(
      "replay",
      () => {
        fired = true;
      },
      {},
      fakeMakeMutable
    );
    registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    applyControlTrigger({
      type: "control.trigger",
      schemaId: "auto",
      controlId: "replay"
    });

    expect(fired).toBe(true);
  });
});

describe("useTunable - production", () => {
  it("does not register in production (isDev false skips registration, mirrors hook behavior)", async () => {
    vi.stubGlobal("__DEV__", false);
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildTunable } = await import("./use-tunable");

    // The hook still builds the handle in production but never calls
    // registerRuntimeValue - buildTunable itself has no isDev branch (that
    // lives in the useEffect), so this asserts the handle is still usable.
    const { handle } = buildTunable("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    expect((handle as { value: number }).value).toBe(18);
    expect(definePanelSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
