import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRIPMessage,
  type PanelSchema,
  type SceneStatus,
  type TriggerControl
} from "@runtime-inspector/protocol";
import { FakeWebSocket } from "./test-utils";

const DEBOUNCE_MS = 50;
const FRAME_MS = 16;

type Sent = { type: string; schema?: PanelSchema };

// index.ts is the package entry and installs the scene.status emitter, so it is
// imported before scenes.ts, exactly as an app loads the package.
async function load() {
  const index = await import("./index");
  const scenes = await import("./scenes");
  const reactNative = await import("react-native");
  return { index, scenes, reactNative };
}

async function connectScenes(): Promise<FakeWebSocket> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.open();
  return socket;
}

function sent(socket: FakeWebSocket): Sent[] {
  return socket.sent.map((raw) => JSON.parse(raw) as Sent);
}

function publishes(socket: FakeWebSocket): PanelSchema[] {
  return sent(socket)
    .filter((message) => message.type === "schema.publish")
    .map((message) => message.schema!);
}

function statuses(socket: FakeWebSocket): SceneStatus[] {
  return socket.sent
    .map((raw) => JSON.parse(raw) as SceneStatus)
    .filter((message) => message.type === "scene.status");
}

function sceneControl(schema: PanelSchema, id: string): TriggerControl | undefined {
  for (const group of schema.groups) {
    const control = group.controls.find((item) => item.id === id);
    if (control) return control as TriggerControl;
  }
  return undefined;
}

function trigger(socket: FakeWebSocket, controlId: string) {
  socket.onmessage?.({
    data: JSON.stringify({ type: "control.trigger", schemaId: "scenes", controlId, source: "panel" })
  });
}

let clock = 1000;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  const { __resetScenesForTests } = await import("./scenes");
  __resetScenesForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("scenes schema", () => {
  it("publishes the scenes schema once after the debounce with groups, order, labels and bindings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scenes } = await load();
    const open = vi.fn();

    scenes.configureScenes({ linkPrefix: "myapp://" });
    scenes.defineScenes({
      "product-reveal": { group: "Store", link: "/product" },
      likeBurst: { title: "Like", group: "Store", link: "myapp://product", description: "Heart pop on like" },
      welcome: { group: "Onboarding", open },
      "loading_spinner.v2": {}
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    const socket = await connectScenes();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const [schema] = publishes(socket);
    expect(publishes(socket)).toHaveLength(1);
    expect(() => parseRIPMessage({ type: "schema.publish", schema })).not.toThrow();
    expect(schema.id).toBe("scenes");
    expect(schema.title).toBe("Scenes");
    expect(schema.groups.map((group) => [group.id, group.label])).toEqual([
      ["Store", "Store"],
      ["Onboarding", "Onboarding"],
      ["scenes", "Scenes"]
    ]);
    expect(schema.groups.map((group) => group.controls.map((control) => control.id))).toEqual([
      ["product-reveal", "likeBurst"],
      ["welcome"],
      ["loading_spinner.v2"]
    ]);
    expect(sceneControl(schema, "product-reveal")).toEqual({
      id: "product-reveal",
      kind: "trigger",
      label: "Product reveal",
      binding: "scenes.product-reveal",
      scene: { url: "myapp://product", active: false, reachable: true }
    });
    expect(sceneControl(schema, "likeBurst")).toEqual({
      id: "likeBurst",
      kind: "trigger",
      label: "Like",
      description: "Heart pop on like",
      binding: "scenes.likeBurst",
      scene: { url: "myapp://product", active: false, reachable: true }
    });
    expect(sceneControl(schema, "welcome")?.scene).toEqual({ active: false, reachable: true });
    expect(sceneControl(schema, "loading_spinner.v2")?.label).toBe("Loading spinner v2");
    expect(sceneControl(schema, "loading_spinner.v2")?.scene).toEqual({ active: false, reachable: false });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("derives titles from ids", async () => {
    const { scenes } = await load();
    scenes.defineScenes({ likeBurst: {}, "product-reveal": {}, "sheet open": {} });
    const socket = await connectScenes();
    const [schema] = publishes(socket);
    expect(sceneControl(schema, "likeBurst")?.label).toBe("Like burst");
    expect(sceneControl(schema, "product-reveal")?.label).toBe("Product reveal");
    expect(sceneControl(schema, "sheet open")?.label).toBe("Sheet open");
  });

  it("ignores blank scene ids with a dev warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scenes } = await load();
    scenes.defineScene("  ", { title: "Blank" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("empty id"));
  });
});

describe("scene declarations", () => {
  it("merges declarations per field; a later call overrides only the fields it sets", async () => {
    const { scenes } = await load();
    const firstOpen = vi.fn();
    const secondOpen = vi.fn();
    scenes.defineScene("card", { title: "Card", group: "Store", link: "myapp://card", open: firstOpen });
    scenes.defineScene("card", { description: "Card flip" });
    scenes.defineScene("card", { title: "Card flip", open: secondOpen });
    const socket = await connectScenes();

    expect(sceneControl(publishes(socket)[0], "card")).toEqual({
      id: "card",
      kind: "trigger",
      label: "Card flip",
      description: "Card flip",
      binding: "scenes.card",
      scene: { url: "myapp://card", active: false, reachable: true }
    });
    expect(publishes(socket)[0].groups.map((group) => group.id)).toEqual(["Store"]);

    scenes.openScene("card");
    expect(secondOpen).toHaveBeenCalledTimes(1);
    expect(firstOpen).not.toHaveBeenCalled();
  });

  it("useScene options only fill fields no declaration set; an undeclared id declares itself", async () => {
    const { scenes } = await load();
    scenes.defineScene("hero", { title: "Hero", group: "Store" });
    scenes.bindScene("hero", () => {}, {
      title: "Fallback",
      group: "Other",
      description: "From the screen",
      link: "myapp://hero"
    });
    scenes.bindScene("badge", () => {}, { title: "Badge pop", group: "Profile" });
    const socket = await connectScenes();

    const [schema] = publishes(socket);
    expect(schema.groups.map((group) => group.id)).toEqual(["Store", "Profile"]);
    expect(sceneControl(schema, "hero")).toMatchObject({
      label: "Hero",
      description: "From the screen",
      scene: { url: "myapp://hero", active: true, reachable: true }
    });
    expect(sceneControl(schema, "badge")?.label).toBe("Badge pop");

    scenes.defineScene("badge", { title: "Declared badge" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(sceneControl(publishes(socket).at(-1)!, "badge")?.label).toBe("Declared badge");
  });
});

describe("resolveSceneLink", () => {
  it("returns absolute links as is and nothing for a path without a resolver", async () => {
    const { scenes } = await load();
    expect(scenes.resolveSceneLink("myapp://product/42")).toBe("myapp://product/42");
    expect(scenes.resolveSceneLink("https://example.com/p")).toBe("https://example.com/p");
    expect(scenes.resolveSceneLink(undefined)).toBeUndefined();
    // No prefix, no Expo Go, no Expo scheme here: the path falls through every step.
    expect(scenes.resolveSceneLink("/product")).toBeUndefined();
  });

  it("prefixes paths with linkPrefix, with and without a trailing slash", async () => {
    const { scenes } = await load();
    scenes.configureScenes({ linkPrefix: "myapp://" });
    expect(scenes.resolveSceneLink("/product/42")).toBe("myapp://product/42");
    expect(scenes.resolveSceneLink("product/42")).toBe("myapp://product/42");
    scenes.configureScenes({ linkPrefix: "https://example.com" });
    expect(scenes.resolveSceneLink("/product/42")).toBe("https://example.com/product/42");
  });

  it("uses Expo Go's experience url when it has a host", async () => {
    vi.stubGlobal("expo", {
      modules: { ExponentConstants: { experienceUrl: "exp://192.168.1.5:8081/", appOwnership: "expo" } }
    });
    const { scenes } = await load();
    expect(scenes.resolveSceneLink("/product")).toBe("exp://192.168.1.5:8081/--/product");
  });

  it("derives the Expo Go base from the Metro script url when the experience url has no host", async () => {
    vi.stubGlobal("expo", {
      modules: { ExponentConstants: { experienceUrl: "exp://", appOwnership: "expo" } }
    });
    const { scenes, reactNative } = await load();
    const original = reactNative.NativeModules.SourceCode;
    reactNative.NativeModules.SourceCode = {
      scriptURL: "http://127.0.0.1:8090/examples/app/index.bundle?platform=ios&dev=true"
    };
    try {
      expect(scenes.resolveSceneLink("/product")).toBe("exp://127.0.0.1:8090/--/product");
    } finally {
      reactNative.NativeModules.SourceCode = original;
    }
  });

  it("does not derive an Expo Go url outside Expo Go", async () => {
    vi.stubGlobal("expo", { modules: { ExponentConstants: { experienceUrl: "exp://" } } });
    const { scenes, reactNative } = await load();
    const original = reactNative.NativeModules.SourceCode;
    reactNative.NativeModules.SourceCode = { scriptURL: "http://127.0.0.1:8090/index.bundle" };
    try {
      expect(scenes.resolveSceneLink("/product")).toBeUndefined();
    } finally {
      reactNative.NativeModules.SourceCode = original;
    }
  });

  it("uses the scheme an Expo development build declares", async () => {
    vi.stubGlobal("expo", {
      modules: {
        ExponentConstants: {
          appOwnership: null,
          manifest: JSON.stringify({ extra: { expoClient: { scheme: "motionapp" } } })
        }
      }
    });
    const { scenes } = await load();
    expect(scenes.resolveSceneLink("/product/42")).toBe("motionapp://product/42");
  });

  it("warns exactly once per scene whose link does not resolve", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scenes } = await load();
    scenes.defineScenes({ a: { link: "/a" }, b: { link: "/b" }, c: { link: "myapp://c" } });
    const socket = await connectScenes();
    scenes.defineScene("a", { title: "A again" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    scenes.defineScene("b", { title: "B again" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((message) => message.includes('Scene "a"'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Scene "b"'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('Scene "c"'))).toHaveLength(0);
    expect(messages[0]).toContain("configureScenes({ linkPrefix");
    expect(sceneControl(publishes(socket).at(-1)!, "a")?.scene).toEqual({ active: false, reachable: false });
  });
});

describe("opening scenes", () => {
  it("plays an on-screen scene once and republishes active state in place", async () => {
    const { scenes } = await load();
    const play = vi.fn();
    const handle = scenes.bindScene("hero", play);
    const socket = await connectScenes();
    expect(sceneControl(publishes(socket)[0], "hero")?.scene).toEqual({ active: true, reachable: true });

    clock = 1500;
    trigger(socket, "hero");
    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket)).toEqual([
      { type: "scene.status", sceneId: "hero", phase: "playing", atRuntimeMs: 1500 }
    ]);

    handle.dispose();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(sceneControl(publishes(socket).at(-1)!, "hero")?.scene).toEqual({ active: false, reachable: false });
    expect(publishes(socket)).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.closeCalls).toBe(0);
    expect(sent(socket).some((message) => message.type === "schema.dispose")).toBe(false);
  });

  it("plays the most recently activated active binding", async () => {
    const { scenes } = await load();
    const first = vi.fn();
    const second = vi.fn();
    scenes.bindScene("hero", first);
    clock = 1100;
    scenes.bindScene("hero", second);
    await connectScenes();
    scenes.openScene("hero");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("navigates with open(), waits for the binding, then plays one frame later", async () => {
    const { scenes } = await load();
    const open = vi.fn();
    const play = vi.fn();
    scenes.defineScene("welcome", { open, link: "myapp://welcome" });
    const socket = await connectScenes();

    clock = 2000;
    trigger(socket, "welcome");
    expect(open).toHaveBeenCalledTimes(1);
    expect(statuses(socket)).toEqual([
      { type: "scene.status", sceneId: "welcome", phase: "navigating", atRuntimeMs: 2000 }
    ]);

    clock = 2300;
    scenes.bindScene("welcome", play);
    expect(play).not.toHaveBeenCalled();
    clock = 2316;
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating", "playing"]);
    expect(statuses(socket)[1].atRuntimeMs).toBe(2316);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses(socket)).toHaveLength(2);
  });

  it("navigates with Linking.openURL when there is no open()", async () => {
    const { scenes, reactNative } = await load();
    const openURL = vi.spyOn(reactNative.Linking, "openURL").mockResolvedValue(true);
    const play = vi.fn();
    scenes.configureScenes({ linkPrefix: "myapp://" });
    scenes.defineScene("product", { link: "/product/42" });
    const socket = await connectScenes();

    trigger(socket, "product");
    expect(openURL).toHaveBeenCalledWith("myapp://product/42");
    scenes.bindScene("product", play);
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating", "playing"]);
  });

  it("does not play again when the screen already ran its entrance", async () => {
    const { scenes } = await load();
    const play = vi.fn();
    scenes.defineScene("intro", { open: () => {} });
    const socket = await connectScenes();

    scenes.openScene("intro");
    clock = 3000;
    const handle = scenes.bindScene("intro", play);
    clock = 3005;
    handle.run(); // entrance in a mount effect
    clock = 3016;
    await vi.advanceTimersByTimeAsync(FRAME_MS);

    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).at(-1)).toEqual({
      type: "scene.status",
      sceneId: "intro",
      phase: "playing",
      atRuntimeMs: 3005
    });
  });

  it("plays when the only run happened before the binding became active", async () => {
    const { scenes } = await load();
    const play = vi.fn();
    scenes.defineScene("intro", { open: () => {} });
    const handle = scenes.bindScene("intro", play, { active: false });
    const socket = await connectScenes();
    handle.run();

    scenes.openScene("intro");
    clock = 1200;
    handle.setActive(true);
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(play).toHaveBeenCalledTimes(2);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating", "playing"]);
  });
});

describe("scene failures", () => {
  it("fails with MOUNT_TIMEOUT after timeoutMs, naming the url and the fix", async () => {
    const { scenes } = await load();
    scenes.defineScene("far", { link: "myapp://far" });
    const socket = await connectScenes();

    scenes.openScene("far");
    await vi.advanceTimersByTimeAsync(4999);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating"]);
    await vi.advanceTimersByTimeAsync(1);
    const failed = statuses(socket)[1];
    expect(failed).toMatchObject({ sceneId: "far", phase: "failed", code: "MOUNT_TIMEOUT" });
    expect(failed.reason).toContain("myapp://far");
    expect(failed.reason).toContain('useScene("far")');
    expect(() => parseRIPMessage(failed)).not.toThrow();
  });

  it("honors configureScenes timeoutMs and ignores an invalid one with a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scenes } = await load();
    scenes.configureScenes({ timeoutMs: 1000 });
    scenes.configureScenes({ timeoutMs: Number.NaN });
    scenes.configureScenes({ timeoutMs: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    scenes.defineScene("far", { open: () => {} });
    const socket = await connectScenes();

    scenes.openScene("far");
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses(socket)[1]).toMatchObject({ phase: "failed", code: "MOUNT_TIMEOUT" });
    expect(statuses(socket)[1].reason).toContain("open()");
  });

  it("fails with UNREACHABLE when the scene is off screen without link or open()", async () => {
    const { scenes } = await load();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    scenes.defineScenes({ nowhere: { title: "Nowhere" }, lost: { link: "/lost" } });
    const socket = await connectScenes();

    scenes.openScene("nowhere");
    scenes.openScene("lost");
    const [nowhere, lost] = statuses(socket);
    expect(nowhere).toMatchObject({ sceneId: "nowhere", phase: "failed", code: "UNREACHABLE" });
    expect(nowhere.reason).toContain("neither a link nor open()");
    expect(lost).toMatchObject({ sceneId: "lost", phase: "failed", code: "UNREACHABLE" });
    expect(lost.reason).toContain("configureScenes({ linkPrefix })");
  });

  it("fails with NAVIGATION_FAILED when open() throws", async () => {
    const { scenes } = await load();
    scenes.defineScene("broken", {
      open: () => {
        throw new Error("router not ready");
      }
    });
    const socket = await connectScenes();

    expect(() => scenes.openScene("broken")).not.toThrow();
    expect(statuses(socket).slice(1)).toEqual([
      {
        type: "scene.status",
        sceneId: "broken",
        phase: "failed",
        atRuntimeMs: 1000,
        code: "NAVIGATION_FAILED",
        reason: "router not ready"
      }
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses(socket)).toHaveLength(2);
  });

  it("fails with NAVIGATION_FAILED when open() or Linking.openURL rejects", async () => {
    const { scenes, reactNative } = await load();
    vi.spyOn(reactNative.Linking, "openURL").mockRejectedValue(new Error("no handler for url"));
    scenes.defineScenes({
      rejecting: { open: () => Promise.reject(new Error("navigation rejected")) },
      linked: { link: "myapp://linked" }
    });
    const socket = await connectScenes();

    scenes.openScene("rejecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(socket).at(-1)).toMatchObject({
      sceneId: "rejecting",
      phase: "failed",
      code: "NAVIGATION_FAILED",
      reason: "navigation rejected"
    });

    scenes.openScene("linked");
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(socket).at(-1)).toMatchObject({
      sceneId: "linked",
      phase: "failed",
      code: "NAVIGATION_FAILED",
      reason: "no handler for url"
    });
    expect(statuses(socket).map((status) => status.phase)).toEqual([
      "navigating",
      "failed",
      "navigating",
      "failed"
    ]);
  });

  it("fails with PLAY_FAILED when play throws, warns, and never rethrows", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scenes } = await load();
    scenes.bindScene("boom", () => {
      throw new Error("bad pose");
    });
    const socket = await connectScenes();

    expect(() => trigger(socket, "boom")).not.toThrow();
    expect(statuses(socket)).toEqual([
      {
        type: "scene.status",
        sceneId: "boom",
        phase: "failed",
        atRuntimeMs: 1000,
        code: "PLAY_FAILED",
        reason: "bad pose"
      }
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("bad pose"));
  });

  it("fails with PLAY_FAILED when the screen leaves before the frame", async () => {
    const { scenes } = await load();
    const play = vi.fn();
    scenes.defineScene("flash", { open: () => {} });
    const socket = await connectScenes();

    scenes.openScene("flash");
    const handle = scenes.bindScene("flash", play);
    handle.dispose();
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(play).not.toHaveBeenCalled();
    expect(statuses(socket).at(-1)).toMatchObject({ phase: "failed", code: "PLAY_FAILED" });
    expect(statuses(socket).at(-1)?.reason).toContain("left the screen");
  });

  it("supersedes a pending open", async () => {
    const { scenes } = await load();
    scenes.defineScenes({ first: { open: () => {} }, second: { open: () => {} } });
    const socket = await connectScenes();

    scenes.openScene("first");
    scenes.openScene("second");
    expect(statuses(socket).map((status) => [status.sceneId, status.phase, status.code])).toEqual([
      ["first", "navigating", undefined],
      ["first", "failed", "SUPERSEDED"],
      ["second", "navigating", undefined]
    ]);
    expect(statuses(socket)[1].reason).toContain('"second"');

    await vi.advanceTimersByTimeAsync(5000);
    expect(statuses(socket).map((status) => [status.sceneId, status.code])).toEqual([
      ["first", undefined],
      ["first", "SUPERSEDED"],
      ["second", undefined],
      ["second", "MOUNT_TIMEOUT"]
    ]);
  });
});

describe("scene binding activity", () => {
  it("setActive(false) makes the scene inactive so opening navigates; setActive(true) plays the pending open", async () => {
    const { scenes } = await load();
    const open = vi.fn();
    const play = vi.fn();
    scenes.defineScene("stacked", { open });
    const handle = scenes.bindScene("stacked", play);
    const socket = await connectScenes();

    handle.setActive(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(sceneControl(publishes(socket).at(-1)!, "stacked")?.scene).toEqual({ active: false, reachable: true });

    scenes.openScene("stacked");
    expect(open).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();

    handle.setActive(true);
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["navigating", "playing"]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(sceneControl(publishes(socket).at(-1)!, "stacked")?.scene).toEqual({ active: true, reachable: true });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("scenes in production", () => {
  it("registers, publishes and opens nothing", async () => {
    vi.stubGlobal("__DEV__", false);
    const { scenes } = await load();
    const open = vi.fn();
    const play = vi.fn();

    scenes.configureScenes({ linkPrefix: "myapp://" });
    scenes.defineScenes({ hero: { open } });
    scenes.defineScene("card", { link: "/card" });
    const handle = scenes.bindScene("hero", play);
    scenes.openScene("hero");
    await vi.advanceTimersByTimeAsync(1000);

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(open).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    handle.run();
    expect(play).toHaveBeenCalledTimes(1);
  });
});

describe("scenes module loading", () => {
  it("still reports scene.status when scenes.ts is loaded before index.ts", async () => {
    const scenes = await import("./scenes");
    await import("./index");
    const play = vi.fn();
    scenes.bindScene("hero", play);
    const socket = await connectScenes();
    scenes.openScene("hero");
    expect(play).toHaveBeenCalledTimes(1);
    expect(statuses(socket).map((status) => status.phase)).toEqual(["playing"]);
  });
});
