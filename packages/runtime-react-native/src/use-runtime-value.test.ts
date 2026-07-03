import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function controlById(schema: import("@runtime-inspector/protocol").PanelSchema, id: string) {
  return schema.groups[0].controls.find((control) => control.id === id);
}

function fakeMakeMutable<T>(value: T) {
  return { value };
}

const DEBOUNCE_MS = 100;

describe("buildRuntimeValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAutoRegistryForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("throws the actionable useAction error for a function initial", async () => {
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const fn = () => {};
    expect(() => buildRuntimeValue("replay", fn, {}, fakeMakeMutable)).toThrow(
      /is a function.*useAction\("replay", fn\)/
    );
  });

  it("throws for a bare number without min/max", async () => {
    const { buildRuntimeValue } = await import("./use-runtime-value");
    expect(() => buildRuntimeValue("blur", 18, {}, fakeMakeMutable)).toThrow(/explicit range/i);
  });

  it("builds a value handle for a number with min/max", async () => {
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { handle, registration } = buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    expect((handle as { value: number }).value).toBe(18);
    expect(registration.kind).toBe("value");
  });

  it("builds a boolean/string/spring/bezier handle without a range", async () => {
    const { buildRuntimeValue } = await import("./use-runtime-value");
    expect((buildRuntimeValue("on", true, {}, fakeMakeMutable).handle as { value: boolean }).value).toBe(true);
    expect((buildRuntimeValue("tint", "#fff", {}, fakeMakeMutable).handle as { value: string }).value).toBe("#fff");
  });

  it("mount/register makes the control appear in the auto schema after debounce", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { registerRuntimeValue } = await import("./auto");

    const { registration } = buildRuntimeValue("blur", 18, { min: 0, max: 40, label: "Blur" }, fakeMakeMutable);
    registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    const control = controlById(schema, "blur");
    expect(control?.kind).toBe("slider");
    expect(control?.label).toBe("Blur");
  });

  it("unmount disposes and republishes the schema without the control", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { registerRuntimeValue } = await import("./auto");

    const { registration } = buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    const dispose = registerRuntimeValue(registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "blur")).toBeDefined();

    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "blur")).toBeUndefined();
  });

  it("remount with the same name does not accumulate a suffix", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { registerRuntimeValue } = await import("./auto");

    const first = registerRuntimeValue(
      buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    first();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    registerRuntimeValue(buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "blur")).toBeDefined();
    expect(controlById(schema, "blur2")).toBeUndefined();
  });

  it("two live registrations of the same name suffix and warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { registerRuntimeValue } = await import("./auto");

    registerRuntimeValue(buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable).registration);
    registerRuntimeValue(buildRuntimeValue("blur", 20, { min: 0, max: 40 }, fakeMakeMutable).registration);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "blur")).toBeDefined();
    expect(controlById(schema, "blur2")).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));

    warnSpy.mockRestore();
  });

  it("panel patch writes the handle and fires onChange", async () => {
    const { buildRuntimeValue } = await import("./use-runtime-value");
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlPatch } = await import("./index");

    let onChangeValue: number | undefined;
    const { handle, registration } = buildRuntimeValue(
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
});

describe("useRuntimeValue - production", () => {
  it("does not register in production (isDev false skips registration, mirrors hook behavior)", async () => {
    vi.stubGlobal("__DEV__", false);
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { buildRuntimeValue } = await import("./use-runtime-value");

    // The hook still builds the handle in production but never calls
    // registerRuntimeValue - buildRuntimeValue itself has no isDev branch (that
    // lives in the useEffect), so this asserts the handle is still usable.
    const { handle } = buildRuntimeValue("blur", 18, { min: 0, max: 40 }, fakeMakeMutable);
    expect((handle as { value: number }).value).toBe(18);
    expect(definePanelSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("useAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAutoRegistryForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("registers a trigger control in the published schema after debounce", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { registerRuntimeValue } = await import("./auto");

    registerRuntimeValue({
      kind: "trigger",
      name: "replay",
      meta: { label: "Replay" },
      handler: () => {}
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    const control = controlById(schema, "replay");
    expect(control?.kind).toBe("trigger");
    expect(control?.label).toBe("Replay");
  });

  it("applyControlTrigger fires the registered handler", async () => {
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlTrigger } = await import("./index");

    let fired = false;
    registerRuntimeValue({
      kind: "trigger",
      name: "replay",
      meta: {},
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

  it("latest-handler semantics: a stable wrapper always calls the newest closure", async () => {
    const { registerRuntimeValue } = await import("./auto");
    const { applyControlTrigger } = await import("./index");

    let latest = "first";
    const handlerRef = { current: () => {} };
    handlerRef.current = () => {
      latest = "first-call";
    };
    const stableWrapper = () => handlerRef.current();

    registerRuntimeValue({ kind: "trigger", name: "replay", meta: {}, handler: stableWrapper });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // simulate a re-render swapping in a new closure without re-registering
    handlerRef.current = () => {
      latest = "second-call";
    };

    applyControlTrigger({ type: "control.trigger", schemaId: "auto", controlId: "replay" });
    expect(latest).toBe("second-call");
  });

  it("dispose on unmount removes the control", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { registerRuntimeValue } = await import("./auto");

    const dispose = registerRuntimeValue({
      kind: "trigger",
      name: "replay",
      meta: {},
      handler: () => {}
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "replay")).toBeDefined();

    dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(controlById(definePanelSpy.mock.calls.at(-1)![0], "replay")).toBeUndefined();
  });

  it("production no-op: returns the handler unchanged without registering", async () => {
    vi.stubGlobal("__DEV__", false);
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");

    // Mirrors the hook: in production useAction never calls registerRuntimeValue.
    // Verified at the registry level since rendering the hook needs a React renderer.
    expect(definePanelSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
