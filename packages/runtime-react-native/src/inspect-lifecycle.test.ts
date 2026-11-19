import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema } from "@runtime-inspector/protocol";
import { FakeWebSocket } from "./test-utils";

/**
 * Minimal component runtime for `useRiInspect`: each instance keeps its own refs across
 * renders, effects run at `commit()` (after the render, like React), and `unmount()` runs
 * the instance's cleanups.
 */
const react = vi.hoisted(() => {
  interface Instance {
    refs: Array<{ current: unknown }>;
    cursor: number;
    pending: Array<() => void | (() => void)>;
    cleanups: Array<() => void>;
  }
  const state: { current?: Instance } = {};
  return {
    state,
    create(): Instance {
      return { refs: [], cursor: 0, pending: [], cleanups: [] };
    }
  };
});

vi.mock("react", () => ({
  useRef<T>(initial: T) {
    const instance = react.state.current!;
    const index = instance.cursor++;
    instance.refs[index] ??= { current: initial };
    return instance.refs[index];
  },
  useEffect(effect: () => void | (() => void)) {
    react.state.current!.pending.push(effect);
  }
}));

type Instance = ReturnType<typeof react.create>;

const DEBOUNCE_MS = 100;
const META = { min: 0, max: 1, label: "progress" };

function controlIds(schema: PanelSchema): string[] {
  return schema.groups[0].controls.map((control) => control.id);
}

async function load() {
  const auto = await import("./auto");
  const core = await import("./core");
  const definePanel = vi.spyOn(core, "definePanel");

  /** Renders `instance` the way the plugin's output does: the hook, then `__riInspect`. */
  function render(instance: Instance, sharedValue: { value: number }, name = "progress") {
    react.state.current = instance;
    instance.cursor = 0;
    const token = auto.useRiInspect(name);
    auto.__riInspect(sharedValue, name, META, token);
    react.state.current = undefined;
  }
  function commit(instance: Instance) {
    for (const effect of instance.pending.splice(0)) {
      const cleanup = effect();
      if (typeof cleanup === "function") instance.cleanups.push(cleanup);
    }
  }
  function unmount(instance: Instance) {
    for (const cleanup of instance.cleanups.splice(0)) cleanup();
  }
  async function published(): Promise<PanelSchema> {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    return definePanel.mock.calls.at(-1)![0];
  }

  return { auto, core, render, commit, unmount, published };
}

describe("useRiInspect (// @inspect disposal on unmount, issue #8)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { __resetAutoRegistryForTests } = await import("./auto");
    __resetAutoRegistryForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("removes the control when its component unmounts", async () => {
    const { render, commit, unmount, published } = await load();
    const screen = react.create();

    render(screen, { value: 0 });
    commit(screen);
    expect(controlIds(await published())).toEqual(["progress"]);

    unmount(screen);
    expect(controlIds(await published())).toEqual([]);
  });

  it("a screen opened again gets its control back, without a suffix or warning", async () => {
    const { render, commit, unmount, published } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = react.create();
    render(first, { value: 0 });
    commit(first);
    unmount(first);

    const second = react.create();
    const sharedValue = { value: 0 };
    render(second, sharedValue);
    commit(second);

    expect(controlIds(await published())).toEqual(["progress"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the newer mount's control when an older instance unmounts after it rendered (navigation)", async () => {
    const { core, render, commit, unmount, published } = await load();
    const oldScreen = react.create();
    const oldValue = { value: 0 };
    render(oldScreen, oldValue);
    commit(oldScreen);

    const newScreen = react.create();
    const newValue = { value: 0 };
    render(newScreen, newValue);
    unmount(oldScreen);
    commit(newScreen);

    expect(controlIds(await published())).toEqual(["progress"]);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress", value: 0.5 });
    expect(newValue.value).toBe(0.5);
    expect(oldValue.value).toBe(0);
  });

  it("hands the control to an instance still mounted when the owner unmounts (list rows)", async () => {
    const { core, render, commit, unmount, published } = await load();
    const rowA = react.create();
    const rowB = react.create();
    const valueA = { value: 0 };
    const valueB = { value: 0 };
    render(rowA, valueA);
    render(rowB, valueB);
    commit(rowA);
    commit(rowB);

    // rowB rendered last and owns the control; it goes away first.
    unmount(rowB);
    expect(controlIds(await published())).toEqual(["progress"]);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress", value: 0.25 });
    expect(valueA.value).toBe(0.25);
    expect(valueB.value).toBe(0);

    unmount(rowA);
    expect(controlIds(await published())).toEqual([]);
  });

  it("survives StrictMode's mount, unmount, mount without a render in between", async () => {
    const { render, commit, unmount, published } = await load();
    const screen = react.create();
    render(screen, { value: 0 });

    // StrictMode commits the effects, runs their cleanups, then runs the same effects again.
    const effects = [...screen.pending];
    commit(screen);
    unmount(screen);
    screen.pending.push(...effects);
    commit(screen);

    expect(controlIds(await published())).toEqual(["progress"]);
  });

  it("next to a live useRuntimeValue of the same name: one suffixed control, gone on unmount", async () => {
    const { auto, render, commit, unmount, published } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    auto.registerRuntimeValue({ kind: "value", name: "progress", sharedValue: { value: 0 }, meta: META, target: 0 });

    const screen = react.create();
    render(screen, { value: 0 });
    commit(screen);
    render(screen, { value: 0 });
    render(screen, { value: 0 });
    expect(controlIds(await published())).toEqual(["progress", "progress2"]);

    unmount(screen);
    expect(controlIds(await published())).toEqual(["progress"]);
    warn.mockRestore();
  });

  it("an un-annotated hand-written __riInspect call is never disposed (RFC 0002 behavior)", async () => {
    const { auto, published } = await load();
    auto.__riInspect({ value: 0 }, "manual", META);
    expect(controlIds(await published())).toEqual(["manual"]);
  });

  it("does nothing in production", async () => {
    vi.stubGlobal("__DEV__", false);
    const { render, commit } = await load();
    const definePanel = vi.spyOn(await import("./core"), "definePanel");
    const screen = react.create();
    render(screen, { value: 0 });
    commit(screen);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(definePanel).not.toHaveBeenCalled();
  });

  it("keeps the last-rendered owner when two instances commit together", async () => {
    const { core, render, commit, published } = await load();
    const a = react.create();
    const b = react.create();
    const va = { value: 0 };
    const vb = { value: 0 };
    render(a, va);
    render(b, vb);
    commit(a);
    commit(b);
    await published();
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress", value: 0.5 });
    expect(vb.value).toBe(0.5);
    expect(va.value).toBe(0);
  });

  it("preserves both suffixed instances after the first rerenders", async () => {
    const { auto, core, render, commit, published } = await load();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    auto.registerRuntimeValue({ kind: "value", name: "progress", sharedValue: { value: 0 }, meta: META, target: 0 });
    const a = react.create();
    const b = react.create();
    const va = { value: 0 };
    const vb = { value: 0 };
    render(a, va);
    commit(a);
    render(b, vb);
    commit(b);
    expect(controlIds(await published())).toEqual(["progress", "progress2", "progress3"]);
    warn.mockClear();
    const rerenderedA = { value: 0 };
    render(a, rerenderedA);
    expect(controlIds(await published())).toEqual(["progress", "progress2", "progress3"]);
    expect(warn).not.toHaveBeenCalled();
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress3", value: 0.5 });
    expect(vb.value).toBe(0.5);
    expect(va.value).toBe(0);
    expect(rerenderedA.value).toBe(0);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress2", value: 0.25 });
    expect(rerenderedA.value).toBe(0.25);
    expect(va.value).toBe(0);
    expect(vb.value).toBe(0.5);
  });

  it("does not reuse a live suffix after an earlier instance unmounts", async () => {
    const { auto, core, render, commit, unmount, published } = await load();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    auto.registerRuntimeValue({ kind: "value", name: "progress", sharedValue: { value: 0 }, meta: META, target: 0 });
    const a = react.create();
    const b = react.create();
    const c = react.create();
    const va = { value: 0 };
    const vb = { value: 0 };
    const vc = { value: 0 };
    render(a, va);
    commit(a);
    render(b, vb);
    commit(b);
    unmount(a);
    render(c, vc);
    commit(c);

    expect(controlIds(await published())).toEqual(["progress", "progress3", "progress4"]);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress3", value: 0.5 });
    expect(vb.value).toBe(0.5);
    expect(va.value).toBe(0);
    expect(vc.value).toBe(0);
    unmount(b);
    expect(controlIds(await published())).toEqual(["progress", "progress4"]);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress4", value: 0.75 });
    expect(vc.value).toBe(0.75);
    expect(vb.value).toBe(0.5);
    unmount(c);
    expect(controlIds(await published())).toEqual(["progress"]);
  });

  it("restores a suffixed instance after StrictMode cleanup without replacing its neighbor", async () => {
    const { auto, core, render, commit, unmount, published } = await load();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const claimed = { value: 0 };
    auto.registerRuntimeValue({ kind: "value", name: "progress", sharedValue: claimed, meta: META, target: 0 });
    const screen = react.create();
    const inspected = { value: 0 };
    render(screen, inspected);
    const effects = [...screen.pending];
    commit(screen);
    unmount(screen);
    screen.pending.push(...effects);
    commit(screen);
    expect(controlIds(await published())).toEqual(["progress", "progress2"]);
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress2", value: 0.5 });
    expect(inspected.value).toBe(0.5);
    expect(claimed.value).toBe(0);
  });

  it("preserves the newest mounted owner through another instance's StrictMode restart", async () => {
    const { core, render, commit, unmount, published } = await load();
    const a = react.create();
    const b = react.create();
    const va = { value: 0 };
    const vb = { value: 0 };
    render(a, va);
    render(b, vb);
    const effectsA = [...a.pending];
    commit(a);
    commit(b);
    unmount(a);
    a.pending.push(...effectsA);
    commit(a);
    await published();
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress", value: 0.5 });
    expect(vb.value).toBe(0.5);
    expect(va.value).toBe(0);
    unmount(b);
    await published();
    core.applyControlPatch({ type: "control.patch", schemaId: "auto", controlId: "progress", value: 0.75 });
    expect(va.value).toBe(0.75);
    expect(vb.value).toBe(0.5);
  });
});
