import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema, RIPMessage, RuntimeAnimationMeta } from "@runtime-inspector/protocol";
import type {
  RuntimeAnimationConfigBinding,
  RuntimeAnimationStartBinding,
  RuntimeAnimationStartWrapBinding
} from "./animation-config";
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

const DELAY_CALLSITE = "App.tsx:31:4:timing:titleY";
const DELAY_CONTROL_ID = `${DELAY_CALLSITE}:delay`;

function delayBinding(
  overrides: Partial<RuntimeAnimationStartBinding> = {}
): RuntimeAnimationStartBinding {
  return {
    callsiteId: DELAY_CALLSITE,
    controlId: DELAY_CONTROL_ID,
    label: "titleY delay",
    declared: 120,
    min: 0,
    max: 10000,
    step: 1,
    unit: "ms",
    ...overrides
  };
}

function startBinding(
  overrides: Partial<RuntimeAnimationStartWrapBinding> = {}
): RuntimeAnimationStartWrapBinding {
  return {
    callsiteId: DELAY_CALLSITE,
    controlId: DELAY_CONTROL_ID,
    label: "titleY delay",
    declared: 0,
    min: 0,
    max: 10000,
    step: 1,
    unit: "ms",
    ...overrides
  };
}

describe("movable start helpers (RFC 0005 3c)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAnimationConfigForTests } = await import("./animation-config");
    const { __resetAnimationStartStateForTests } = await import("./animation-start-state");
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAnimationConfigForTests();
    __resetAnimationStartStateForTests();
    __resetAutoRegistryForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  describe("__riAnimationDelay", () => {
    it("returns the declared literal until the control is patched, then the tuned value", async () => {
      const { applyControlPatch } = await import("./index");
      const { __riAnimationDelay } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");

      expect(__riAnimationDelay(120, delayBinding())).toBe(120);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(120);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      applyControlPatch({
        type: "control.patch",
        schemaId: "auto",
        controlId: DELAY_CONTROL_ID,
        value: 300
      });

      expect(__riAnimationDelay(120, delayBinding())).toBe(300);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(300);
    });

    it("publishes one slider with the given fields and does not re-register on repeat calls", async () => {
      const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
      const { __riAnimationDelay } = await import("./animation-config");

      __riAnimationDelay(120, delayBinding());
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(definePanelSpy).toHaveBeenCalledTimes(1);
      const schema = definePanelSpy.mock.calls.at(-1)![0];
      expect(schema.id).toBe("auto");
      expect(schema.groups[0].controls).toHaveLength(1);
      expect(controlById(schema, DELAY_CONTROL_ID)).toMatchObject({
        id: DELAY_CONTROL_ID,
        kind: "slider",
        label: "titleY delay",
        defaultValue: 120,
        min: 0,
        max: 10000,
        step: 1,
        unit: "ms",
        binding: `auto.${DELAY_CONTROL_ID}`
      });

      __riAnimationDelay(120, delayBinding());
      __riAnimationDelay(120, delayBinding());
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 5);
      expect(definePanelSpy).toHaveBeenCalledTimes(1);
    });

    it("returns the original argument and registers nothing for a binding without a control", async () => {
      const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
      const registerSpy = vi.spyOn(await import("./auto"), "registerRuntimeValue");
      const { __riAnimationDelay } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");

      expect(__riAnimationDelay(240, { callsiteId: DELAY_CALLSITE })).toBe(240);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(240);

      const stagger = { valueOf: () => 7 };
      expect(__riAnimationDelay(stagger, { callsiteId: DELAY_CALLSITE })).toBe(stagger);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(0);

      expect(__riAnimationDelay(-5, { callsiteId: DELAY_CALLSITE })).toBe(-5);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(0);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(registerSpy).not.toHaveBeenCalled();
      expect(definePanelSpy).not.toHaveBeenCalled();
    });

    it("is a no-op in production - returns the delay, registers and records nothing", async () => {
      vi.stubGlobal("__DEV__", false);
      const registerSpy = vi.spyOn(await import("./auto"), "registerRuntimeValue");
      const { __riAnimationDelay } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");

      expect(__riAnimationDelay(120, delayBinding())).toBe(120);

      expect(registerSpy).not.toHaveBeenCalled();
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBeUndefined();
    });

    it("never throws into application code: returns the delay and warns once", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(await import("./auto"), "registerRuntimeValue").mockImplementation(() => {
        throw new Error("registry exploded");
      });
      const { __riAnimationDelay } = await import("./animation-config");

      expect(__riAnimationDelay(120, delayBinding())).toBe(120);
      expect(__riAnimationDelay(120, delayBinding())).toBe(120);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Runtime Inspector]"));
    });
  });

  describe("__riAnimationStart", () => {
    it("returns the same animation object and never calls withDelay while the control is 0", async () => {
      const { __riAnimationStart } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");
      const withDelay = vi.fn();
      const animation = { marker: "animation" };

      expect(__riAnimationStart(animation, startBinding(), withDelay)).toBe(animation);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      expect(__riAnimationStart(animation, startBinding(), withDelay)).toBe(animation);

      expect(withDelay).not.toHaveBeenCalled();
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(0);
    });

    it("publishes one slider declared at 0 with the given fields", async () => {
      const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
      const { __riAnimationStart } = await import("./animation-config");

      __riAnimationStart({}, startBinding(), vi.fn());
      __riAnimationStart({}, startBinding(), vi.fn());
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

      expect(definePanelSpy).toHaveBeenCalledTimes(1);
      const schema = definePanelSpy.mock.calls.at(-1)![0];
      expect(controlById(schema, DELAY_CONTROL_ID)).toMatchObject({
        kind: "slider",
        label: "titleY delay",
        defaultValue: 0,
        min: 0,
        max: 10000,
        step: 1,
        unit: "ms"
      });
    });

    it("delegates to the provided withDelay once the control is tuned above 0", async () => {
      const { applyControlPatch } = await import("./index");
      const { __riAnimationStart } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");
      const animation = { marker: "animation" };
      const delayed = { marker: "delayed" };
      const withDelay = vi.fn(() => delayed);

      __riAnimationStart(animation, startBinding(), withDelay);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      consumeAppliedStartDelay(DELAY_CALLSITE);

      applyControlPatch({
        type: "control.patch",
        schemaId: "auto",
        controlId: DELAY_CONTROL_ID,
        value: 150
      });

      expect(__riAnimationStart(animation, startBinding(), withDelay)).toBe(delayed);
      expect(withDelay).toHaveBeenCalledTimes(1);
      expect(withDelay).toHaveBeenCalledWith(150, animation);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(150);
    });

    it("returns the animation unchanged when withDelay is not a function", async () => {
      const { applyControlPatch } = await import("./index");
      const { __riAnimationStart } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");
      const animation = { marker: "animation" };

      __riAnimationStart(animation, startBinding(), undefined);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      applyControlPatch({
        type: "control.patch",
        schemaId: "auto",
        controlId: DELAY_CONTROL_ID,
        value: 150
      });

      expect(__riAnimationStart(animation, startBinding(), undefined)).toBe(animation);
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBe(0);
    });

    it("is a no-op in production - returns the animation, registers and records nothing", async () => {
      vi.stubGlobal("__DEV__", false);
      const registerSpy = vi.spyOn(await import("./auto"), "registerRuntimeValue");
      const { __riAnimationStart } = await import("./animation-config");
      const { consumeAppliedStartDelay } = await import("./animation-start-state");
      const withDelay = vi.fn();
      const animation = {};

      expect(__riAnimationStart(animation, startBinding(), withDelay)).toBe(animation);

      expect(withDelay).not.toHaveBeenCalled();
      expect(registerSpy).not.toHaveBeenCalled();
      expect(consumeAppliedStartDelay(DELAY_CALLSITE)).toBeUndefined();
    });

    it("never throws into application code: returns the animation and warns once", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(await import("./auto"), "registerRuntimeValue").mockImplementation(() => {
        throw new Error("registry exploded");
      });
      const { __riAnimationStart } = await import("./animation-config");
      const animation = {};

      expect(__riAnimationStart(animation, startBinding(), vi.fn())).toBe(animation);
      expect(__riAnimationStart(animation, startBinding(), vi.fn())).toBe(animation);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[Runtime Inspector]"));
    });

    it("returns the animation when the provided withDelay throws", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { applyControlPatch } = await import("./index");
      const { __riAnimationStart } = await import("./animation-config");
      const animation = {};
      const withDelay = vi.fn(() => {
        throw new Error("withDelay exploded");
      });

      __riAnimationStart(animation, startBinding(), withDelay);
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      applyControlPatch({
        type: "control.patch",
        schemaId: "auto",
        controlId: DELAY_CONTROL_ID,
        value: 150
      });

      expect(__riAnimationStart(animation, startBinding(), withDelay)).toBe(animation);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("__riObserveAnimation start reporting (RFC 0005 3c)", () => {
  const startControl = { schemaId: "auto", controlId: DELAY_CONTROL_ID };
  const meta: RuntimeAnimationMeta = {
    callsiteId: DELAY_CALLSITE,
    schemaId: "card-transition",
    target: "titleY",
    animationKind: "timing",
    toValue: 0,
    config: { duration: 380 },
    startControl
  };

  afterEach(async () => {
    const { __resetAnimationStartStateForTests } = await import("./animation-start-state");
    __resetAnimationStartStateForTests();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("shifts startedAtRuntimeMs by the applied delay and reports startDelayMs", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const { recordAppliedStartDelay } = await import("./animation-start-state");
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    recordAppliedStartDelay(DELAY_CALLSITE, 120);
    const animation = {};
    expect(__riObserveAnimation(animation, meta)).toBe(animation);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "animation.started",
      startedAtRuntimeMs: 1120,
      startDelayMs: 120,
      startControl
    });
  });

  it("reports startDelayMs 0 when the start helper applied no delay", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const { recordAppliedStartDelay } = await import("./animation-start-state");
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    recordAppliedStartDelay(DELAY_CALLSITE, 0);
    __riObserveAnimation({}, meta);

    expect(emitted[0]).toMatchObject({ startedAtRuntimeMs: 1000, startDelayMs: 0 });
  });

  it("omits startDelayMs and startControl when no start helper ran for the call site", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    const { startControl: _omitted, ...withoutStartControl } = meta;
    __riObserveAnimation({}, withoutStartControl);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ startedAtRuntimeMs: 1000 });
    expect("startDelayMs" in emitted[0]).toBe(false);
    expect("startControl" in emitted[0]).toBe(false);
  });

  it("consumes the applied delay so it is not reused by the next call", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { __riObserveAnimation, setRuntimeAnimationEmitter } = await import(
      "./animation-observer"
    );
    const { recordAppliedStartDelay } = await import("./animation-start-state");
    const emitted: RIPMessage[] = [];
    setRuntimeAnimationEmitter((_schemaId, message) => emitted.push(message));

    recordAppliedStartDelay(DELAY_CALLSITE, 120);
    __riObserveAnimation({}, meta);
    __riObserveAnimation({}, meta);

    expect(emitted[1]).toMatchObject({ startedAtRuntimeMs: 1000 });
    expect("startDelayMs" in emitted[1]).toBe(false);
  });
});

describe("literal anchors (RFC 0007)", () => {
  const literalBase = {
    file: "src/WelcomeDemo.tsx",
    line: 41,
    column: 4,
    enclosure: ["WelcomeDemo", "play"],
    target: "titleY.value",
    callee: "withTiming" as const
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAnimationConfigForTests } = await import("./animation-config");
    const { __resetAnimationStartStateForTests } = await import("./animation-start-state");
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAnimationConfigForTests();
    __resetAnimationStartStateForTests();
    __resetAutoRegistryForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("copies the literal of every helper's binding onto its control", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riAnimationConfig, __riAnimationDelay, __riAnimationStart } = await import(
      "./animation-config"
    );
    const durationLiteral = { ...literalBase, parameter: "duration" as const, init: "380" };
    const delayLiteral = { ...literalBase, parameter: "delay" as const, init: "140" };
    const startLiteral = {
      ...literalBase,
      line: 42,
      target: "logo.value",
      parameter: "delay" as const,
      init: null
    };

    __riAnimationConfig({ duration: 380 }, [
      durationBinding({ controlId: "duration", declared: 380, literal: durationLiteral })
    ]);
    __riAnimationDelay(140, {
      callsiteId: "titleY",
      controlId: "delay",
      label: "titleY delay",
      declared: 140,
      min: 0,
      max: 10000,
      literal: delayLiteral
    });
    __riAnimationStart(
      {},
      {
        callsiteId: "logo",
        controlId: "start",
        label: "logo delay",
        declared: 0,
        min: 0,
        max: 10000,
        literal: startLiteral
      },
      vi.fn()
    );
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, "duration")).toMatchObject({ literal: durationLiteral });
    expect(controlById(schema, "delay")).toMatchObject({ literal: delayLiteral });
    expect(controlById(schema, "start")).toMatchObject({ literal: startLiteral });
    expect(controlById(schema, "duration")).not.toHaveProperty("source");
  });

  it("re-registers a new anchor for the same literal, keeping the tuned value", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { applyControlPatch } = await import("./index");
    const { __riAnimationConfig } = await import("./animation-config");
    const before = { ...literalBase, parameter: "duration" as const, init: "380" };
    const after = { ...before, enclosure: ["WelcomeDemo", "intro"], init: "380.0" };
    const config = { duration: 380 };

    __riAnimationConfig(config, [durationBinding({ declared: 380, literal: before })]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: CONTROL_ID, value: 420 });

    // Same anchor: nothing is republished.
    __riAnimationConfig(config, [durationBinding({ declared: 380, literal: { ...before } })]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(definePanelSpy).toHaveBeenCalledTimes(1);

    const tuned = __riAnimationConfig(config, [durationBinding({ declared: 380, literal: after })]);
    expect(tuned).toEqual({ duration: 420 });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(definePanelSpy).toHaveBeenCalledTimes(2);
    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(schema.groups[0].controls).toHaveLength(1);
    expect(controlById(schema, CONTROL_ID)).toMatchObject({
      defaultValue: 380,
      value: 420,
      literal: after
    });
  });

  it("publishes the declared literal as the default when the schema republishes while tuned", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { applyControlPatch } = await import("./index");
    const { __riAnimationConfig } = await import("./animation-config");

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: CONTROL_ID, value: 400 });

    // Another call site registers, which republishes the whole auto schema.
    __riAnimationConfig({ duration: 100 }, [durationBinding({ controlId: "other", declared: 100 })]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, CONTROL_ID)).toMatchObject({ defaultValue: 260, value: 400 });
    expect(controlById(schema, "other")).toMatchObject({ defaultValue: 100, value: 100 });
  });

  it("publishes no literal field for a binding without one", async () => {
    const definePanelSpy = vi.spyOn(await import("./index"), "definePanel");
    const { __riAnimationConfig } = await import("./animation-config");

    __riAnimationConfig({ duration: 260 }, [durationBinding()]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const schema = definePanelSpy.mock.calls.at(-1)![0];
    expect(controlById(schema, CONTROL_ID)).not.toHaveProperty("literal");
  });
});
