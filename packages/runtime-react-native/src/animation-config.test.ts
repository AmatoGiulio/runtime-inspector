import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema, RIPMessage, RuntimeAnimationMeta } from "@runtime-inspector/protocol";
import type { RuntimeAnimationConfigBinding } from "./animation-config";
import { FakeWebSocket } from "./test-utils";

const DEBOUNCE_MS = 100;
const CONTROL_ID = "App.tsx:74:4:timing:card.moveX:duration";

function durationBinding(
  overrides: Partial<RuntimeAnimationConfigBinding> = {}
): RuntimeAnimationConfigBinding {
  return {
    key: "duration",
    controlId: CONTROL_ID,
    label: "card.moveX duration",
    declared: 260,
    min: 0,
    max: 10000,
    step: 1,
    unit: "ms",
    ...overrides
  };
}

function controlById(schema: PanelSchema, id: string) {
  return schema.groups[0].controls.find((control) => control.id === id);
}

describe("__riAnimationConfig", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAnimationConfigForTests } = await import("./animation-config");
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAnimationConfigForTests();
    __resetAutoRegistryForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("returns the same config object by identity while the control is untouched", async () => {
    const { __riAnimationConfig } = await import("./animation-config");
    const config = { duration: 260, easing: "ease" };

    expect(__riAnimationConfig(config, [durationBinding()])).toBe(config);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(__riAnimationConfig(config, [durationBinding()])).toBe(config);
    expect(config).toEqual({ duration: 260, easing: "ease" });
  });

  it("publishes one slider control in the auto schema after the debounce", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riAnimationConfig } = await import("./animation-config");

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    expect(definePanelSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(definePanelSpy).toHaveBeenCalledTimes(1);
    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(schema.id).toBe("auto");
    expect(schema.groups[0].controls).toHaveLength(1);
    expect(controlById(schema, CONTROL_ID)).toMatchObject({
      id: CONTROL_ID,
      kind: "slider",
      label: "card.moveX duration",
      defaultValue: 260,
      min: 0,
      max: 10000,
      step: 1,
      unit: "ms",
      binding: `auto.${CONTROL_ID}`
    });
  });

  it("does not schedule another publish when called again with the same binding", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riAnimationConfig } = await import("./animation-config");

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(definePanelSpy).toHaveBeenCalledTimes(1);

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 5);

    expect(definePanelSpy).toHaveBeenCalledTimes(1);
  });

  it("returns a new object with the tuned duration after the control is patched", async () => {
    const { applyControlPatch } = await import("./index");
    const { __riAnimationConfig } = await import("./animation-config");
    const easing = () => 0;
    const config = { duration: 260, easing };

    __riAnimationConfig(config, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    applyControlPatch({
      type: "control.patch",
      schemaId: "auto",
      controlId: CONTROL_ID,
      value: 400
    });

    const tuned = __riAnimationConfig(config, [durationBinding()]);
    expect(tuned).not.toBe(config);
    expect(tuned).toEqual({ duration: 400, easing });
    expect(tuned.easing).toBe(easing);
    expect(config).toEqual({ duration: 260, easing });
  });

  it("resets to the new declared value and republishes when the source literal changes", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { applyControlPatch } = await import("./index");
    const { __riAnimationConfig } = await import("./animation-config");

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    applyControlPatch({
      type: "control.patch",
      schemaId: "auto",
      controlId: CONTROL_ID,
      value: 400
    });
    expect(__riAnimationConfig({ duration: 260 }, [durationBinding()])).toEqual({ duration: 400 });
    const publishesBefore = definePanelSpy.mock.calls.length;

    const edited = { duration: 300 };
    expect(__riAnimationConfig(edited, [durationBinding({ declared: 300 })])).toBe(edited);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(definePanelSpy.mock.calls.length).toBe(publishesBefore + 1);
    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(schema.groups[0].controls).toHaveLength(1);
    expect(controlById(schema, CONTROL_ID)).toMatchObject({ kind: "slider", defaultValue: 300 });
    expect(__riAnimationConfig(edited, [durationBinding({ declared: 300 })])).toBe(edited);
  });

  it("is a no-op in production - returns config and registers nothing", async () => {
    vi.stubGlobal("__DEV__", false);
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const registerSpy = vi.spyOn(await import("./auto"), "registerRuntimeValue");
    const { __riAnimationConfig } = await import("./animation-config");
    const config = { duration: 260 };

    expect(__riAnimationConfig(config, [durationBinding()])).toBe(config);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(definePanelSpy).not.toHaveBeenCalled();
  });

  it("ignores a binding whose declared value is not finite", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const registerSpy = vi.spyOn(await import("./auto"), "registerRuntimeValue");
    const { __riAnimationConfig } = await import("./animation-config");
    const config = { duration: Number.NaN };

    expect(__riAnimationConfig(config, [durationBinding({ declared: Number.NaN })])).toBe(config);
    expect(
      __riAnimationConfig(config, [durationBinding({ declared: Number.POSITIVE_INFINITY })])
    ).toBe(config);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(definePanelSpy).not.toHaveBeenCalled();
  });

  it("never throws into application code: returns config and warns once on internal failure", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(await import("./auto"), "registerRuntimeValue").mockImplementation(() => {
      throw new Error("registry exploded");
    });
    const { __riAnimationConfig } = await import("./animation-config");
    const config = { duration: 260 };

    expect(__riAnimationConfig(config, [durationBinding()])).toBe(config);
    expect(__riAnimationConfig(config, [durationBinding()])).toBe(config);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Runtime Inspector]"));
  });
});

describe("__riObserveAnimation parameterControls forwarding", () => {
  const meta: RuntimeAnimationMeta = {
    callsiteId: "App.tsx:74:4:timing:card.moveX",
    schemaId: "card-transition",
    target: "card.moveX",
    animationKind: "timing",
    toValue: -110,
    config: { duration: 260 }
  };

  afterEach(() => {
    vi.resetModules();
  });

  it("forwards parameterControls from the meta onto animation.started", async () => {
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    const parameterControls = { duration: { schemaId: "auto", controlId: CONTROL_ID } };
    const animation = { marker: "animation" };
    expect(__riObserveAnimation(animation, { ...meta, parameterControls })).toBe(animation);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "animation.started", parameterControls });
  });

  it("omits the parameterControls key when the meta has none", async () => {
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    __riObserveAnimation({}, meta);

    expect(emitted).toHaveLength(1);
    expect("parameterControls" in emitted[0]).toBe(false);
  });
});
