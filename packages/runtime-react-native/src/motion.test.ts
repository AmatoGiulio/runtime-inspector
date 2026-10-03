import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema, SceneStatus, TriggerControl } from "@runtime-inspector/protocol";
import { FakeWebSocket } from "./test-utils";

const DEBOUNCE_MS = 50;
const FRAME_MS = 16;

/** Minimal hook runtime: `useRef` keeps one ref per call order, `useEffect` runs on "mount". */
const hooks = vi.hoisted(() => {
  const state = {
    refs: [] as Array<{ current: unknown }>,
    refIndex: 0,
    cleanups: [] as Array<() => void>,
    mounted: false
  };
  return {
    state,
    render<T>(component: () => T): T {
      state.refIndex = 0;
      return component();
    },
    unmount() {
      for (const cleanup of state.cleanups.splice(0)) cleanup();
    },
    reset() {
      state.refs = [];
      state.refIndex = 0;
      state.cleanups = [];
      state.mounted = false;
    }
  };
});

vi.mock("react", () => ({
  useRef<T>(initial: T) {
    const index = hooks.state.refIndex++;
    if (!hooks.state.refs[index]) hooks.state.refs[index] = { current: initial };
    return hooks.state.refs[index] as { current: T };
  },
  useEffect(effect: () => void | (() => void)) {
    if (hooks.state.mounted) return;
    const cleanup = effect();
    if (typeof cleanup === "function") hooks.state.cleanups.push(cleanup);
  }
}));

async function load() {
  const index = await import("./index");
  const scenes = await import("./scenes");
  const motion = await import("./motion");
  const observer = await import("./animation-observer");
  return { index, scenes, motion, observer };
}

async function connectScenes(): Promise<FakeWebSocket> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return socket;
}

function lastScenesSchema(socket: FakeWebSocket): PanelSchema {
  const publishes = socket.sent
    .map((raw) => JSON.parse(raw) as { type: string; schema?: PanelSchema })
    .filter((message) => message.type === "schema.publish");
  return publishes.at(-1)!.schema!;
}

function sceneControl(schema: PanelSchema, id: string): TriggerControl | undefined {
  for (const group of schema.groups) {
    const control = group.controls.find((item) => item.id === id);
    if (control) return control as TriggerControl;
  }
  return undefined;
}

function statuses(socket: FakeWebSocket): SceneStatus[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as SceneStatus)
    .filter((message) => message.type === "scene.status");
}

const SCENE_ID = "src/ProductRevealDemo.tsx:ProductRevealDemo.play";
const CALLSITE = "src/ProductRevealDemo.tsx:24:4:timing:coverOpacity";
const META = {
  component: "ProductRevealDemo",
  name: "play",
  file: "src/ProductRevealDemo.tsx",
  line: 22,
  callsites: [CALLSITE]
};

let clock = 1000;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  hooks.reset();
});

afterEach(async () => {
  hooks.unmount();
  const { __resetScenesForTests } = await import("./scenes");
  __resetScenesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("humanized defaults", () => {
  it("humanizes component and function names; an effect is On mount", async () => {
    const { motion } = await load();
    expect(motion.humanizeIdentifier("ProductRevealDemo")).toBe("Product reveal demo");
    expect(motion.humanizeIdentifier("replayTransition")).toBe("Replay transition");
    expect(motion.motionTitle("play")).toBe("Play");
    expect(motion.motionTitle("replayTransition")).toBe("Replay transition");
    expect(motion.motionTitle("effect")).toBe("On mount");
  });
});

describe("__riMotion", () => {
  it("returns the same function, binds the scene on mount and unbinds on unmount", async () => {
    const { motion } = await load();
    const play = vi.fn();

    const returned = hooks.render(() => motion.__riMotion(SCENE_ID, play, META));
    expect(returned).toBe(play);

    const socket = await connectScenes();
    expect(sceneControl(lastScenesSchema(socket), SCENE_ID)).toMatchObject({
      id: SCENE_ID,
      label: "Play",
      scene: { active: true, reachable: true }
    });
    expect(lastScenesSchema(socket).groups.map((group) => group.label)).toEqual(["Product reveal demo"]);

    hooks.unmount();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(sceneControl(lastScenesSchema(socket), SCENE_ID)?.scene).toEqual({
      active: false,
      reachable: false
    });
    expect(play).not.toHaveBeenCalled();
  });

  it("uses the // @scene title and group over the humanized defaults", async () => {
    const { motion } = await load();
    hooks.render(() =>
      motion.__riMotion(SCENE_ID, () => {}, { ...META, title: "Product reveal", group: "Store" })
    );

    const socket = await connectScenes();
    const schema = lastScenesSchema(socket);
    expect(schema.groups.map((group) => group.label)).toEqual(["Store"]);
    expect(sceneControl(schema, SCENE_ID)?.label).toBe("Product reveal");
  });

  it("opening the scene plays the latest function", async () => {
    const { motion } = await load();
    const first = vi.fn();
    const latest = vi.fn();
    hooks.render(() => motion.__riMotion(SCENE_ID, first, META));
    hooks.state.mounted = true;
    hooks.render(() => motion.__riMotion(SCENE_ID, latest, META));

    const socket = await connectScenes();
    socket.onmessage?.({
      data: JSON.stringify({ type: "control.trigger", schemaId: "scenes", controlId: SCENE_ID, source: "panel" })
    });

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(statuses(socket).at(-1)).toMatchObject({ sceneId: SCENE_ID, phase: "playing" });
  });

  it("returns the function and registers nothing in production", async () => {
    vi.stubGlobal("__DEV__", false);
    const { motion } = await load();
    const play = vi.fn();

    expect(hooks.render(() => motion.__riMotion(SCENE_ID, play, META))).toBe(play);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("automatic scene already ran (callsites)", () => {
  it("does not play again when one of its callsites started after the binding became active", async () => {
    const { scenes, motion, observer } = await load();
    const play = vi.fn();
    scenes.defineScene(SCENE_ID, { open: () => {} });
    const socket = await connectScenes();

    scenes.openScene(SCENE_ID);
    clock = 3000;
    motion.bindMotion(SCENE_ID, play, META);
    clock = 3005;
    // The app's own mount effect calls its play function, which starts the animation.
    observer.__riObserveAnimation({}, {
      callsiteId: CALLSITE,
      target: "coverOpacity",
      animationKind: "timing",
      config: {}
    });
    clock = 3016;
    await vi.advanceTimersByTimeAsync(FRAME_MS);

    expect(play).not.toHaveBeenCalled();
    expect(statuses(socket).at(-1)).toEqual({
      type: "scene.status",
      sceneId: SCENE_ID,
      phase: "playing",
      atRuntimeMs: 3005
    });
  });

  it("plays when only an unrelated callsite started, or the callsite started before activation", async () => {
    const { scenes, motion } = await load();
    const play = vi.fn();
    scenes.defineScene(SCENE_ID, { open: () => {} });
    const socket = await connectScenes();

    scenes.noteAnimationCallsiteStarted(CALLSITE, 900);
    scenes.openScene(SCENE_ID);
    clock = 3000;
    motion.bindMotion(SCENE_ID, play, META);
    scenes.noteAnimationCallsiteStarted("src/Other.tsx:1:1:timing:x", 3005);
    await vi.advanceTimersByTimeAsync(FRAME_MS);

    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating", "playing"]);
  });

  it("ignores the binding's own run function for automatic scenes", async () => {
    const { scenes, motion } = await load();
    const play = vi.fn();
    scenes.defineScene(SCENE_ID, { open: () => {} });
    await connectScenes();

    scenes.openScene(SCENE_ID);
    clock = 3000;
    const handle = motion.bindMotion(SCENE_ID, play, META);
    clock = 3005;
    handle.run();
    await vi.advanceTimersByTimeAsync(FRAME_MS);

    // The run recorded by the handle does not count: no callsite reported a start.
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("an explicit useScene binding keeps the lastRunAt logic", async () => {
    const { scenes } = await load();
    const play = vi.fn();
    scenes.defineScene("intro", { open: () => {} });
    await connectScenes();

    scenes.openScene("intro");
    clock = 3000;
    scenes.bindScene("intro", play);
    clock = 3005;
    scenes.noteAnimationCallsiteStarted(CALLSITE, 3005);
    await vi.advanceTimersByTimeAsync(FRAME_MS);

    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe("explicit declaration of an automatic scene", () => {
  it("merges defineScene fields with the automatic id", async () => {
    const { scenes, motion } = await load();
    const open = vi.fn();
    scenes.configureScenes({ linkPrefix: "myapp://" });
    scenes.defineScene(SCENE_ID, { title: "Album reveal", link: "/product", open });
    motion.bindMotion(SCENE_ID, () => {}, { ...META, group: "Store" });

    const socket = await connectScenes();
    const schema = lastScenesSchema(socket);
    expect(schema.groups.map((group) => group.label)).toEqual(["Store"]);
    expect(sceneControl(schema, SCENE_ID)).toMatchObject({
      label: "Album reveal",
      scene: { url: "myapp://product", active: true, reachable: true }
    });
  });
});
