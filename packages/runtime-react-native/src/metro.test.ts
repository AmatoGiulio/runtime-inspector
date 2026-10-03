import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWithRuntimeInspector,
  type MetroConfigLike,
  type MetroResolutionContext,
  type RuntimeInspectorMetroDeps
} from "./metro";

const projectRoot = "/app";
const panelRoot = "/repo/packages/panel-rozenite";
const rozeniteEntry = "/repo/packages/runtime-react-native/rozenite-entry.js";

interface Harness {
  deps: RuntimeInspectorMetroDeps;
  withRozenite: ReturnType<typeof vi.fn>;
  warnings: string[];
}

function harness(resolvable: { rozeniteMetro?: boolean; panel?: boolean } = {}): Harness {
  const warnings: string[] = [];
  const withRozenite = vi.fn((config: unknown) => async () => ({ ...(config as object), rozenite: true }));
  const deps: RuntimeInspectorMetroDeps = {
    resolveFrom(_root, request) {
      if (request === "@rozenite/metro" && resolvable.rozeniteMetro) {
        return "/app/node_modules/@rozenite/metro/dist/index.cjs";
      }
      if (request === "@runtime-inspector/panel-rozenite/package.json" && resolvable.panel) {
        return `${panelRoot}/package.json`;
      }
      return undefined;
    },
    requireFrom(_root, request) {
      if (request === "@rozenite/metro") return { withRozenite };
      throw new Error(`unexpected require ${request}`);
    },
    rozeniteEntryPath: () => rozeniteEntry,
    warn: (message) => warnings.push(message)
  };
  return { deps, withRozenite, warnings };
}

function context(originModulePath: string, defaultResolve = vi.fn(() => "default")) {
  return {
    originModulePath,
    resolveRequest: defaultResolve,
    extra: "kept"
  } satisfies MetroResolutionContext;
}

function baseConfig(): MetroConfigLike {
  return {
    projectRoot,
    watchFolders: ["/repo"],
    resolver: { sourceExts: ["ts", "tsx", "js"] },
    serializer: { getModulesRunBeforeMainModule: () => ["/InitializeCore.js"] }
  };
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.WITH_ROZENITE;
  delete process.env.WITH_ROZENITE;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.WITH_ROZENITE;
  else process.env.WITH_ROZENITE = savedEnv;
});

describe("withRuntimeInspector singletons", () => {
  it.each(["react", "react-native", "react-native-reanimated", "react-native/Libraries/Core/InitializeCore", "react/jsx-runtime"])(
    "resolves %s as if required from the project root",
    (moduleName) => {
      const { deps } = harness();
      const config = createWithRuntimeInspector(deps)(baseConfig()) as MetroConfigLike;
      const defaultResolve = vi.fn(() => "resolved");
      const ctx = context("/repo/packages/runtime-react-native/dist/index.js", defaultResolve);

      expect(config.resolver?.resolveRequest?.(ctx, moduleName, "ios")).toBe("resolved");
      expect(defaultResolve).toHaveBeenCalledWith(
        { ...ctx, originModulePath: path.join(projectRoot, "index.js") },
        moduleName,
        "ios"
      );
    }
  );

  it("leaves other modules (and look-alike names) with their original origin", () => {
    const { deps } = harness();
    const config = createWithRuntimeInspector(deps)(baseConfig()) as MetroConfigLike;
    for (const moduleName of ["lodash", "react-native-svg", "reactive", "./local"]) {
      const defaultResolve = vi.fn(() => "resolved");
      const ctx = context("/app/src/App.tsx", defaultResolve);
      config.resolver?.resolveRequest?.(ctx, moduleName, null);
      expect(defaultResolve).toHaveBeenCalledWith(ctx, moduleName, null);
    }
  });

  it("composes an existing resolveRequest instead of the context default", () => {
    const { deps } = harness();
    const previous = vi.fn(() => "previous");
    const input = baseConfig();
    input.resolver = { ...input.resolver, resolveRequest: previous };
    const config = createWithRuntimeInspector(deps)(input) as MetroConfigLike;
    const defaultResolve = vi.fn();

    expect(config.resolver?.resolveRequest?.(context("/x/y.js", defaultResolve), "react", "android")).toBe(
      "previous"
    );
    expect(previous).toHaveBeenCalledWith(
      expect.objectContaining({ originModulePath: "/app/index.js" }),
      "react",
      "android"
    );
    expect(config.resolver?.resolveRequest?.(context("/x/y.js", defaultResolve), "lodash", "android")).toBe(
      "previous"
    );
    expect(defaultResolve).not.toHaveBeenCalled();
  });

  it("falls back to process.cwd() without projectRoot", () => {
    const { deps } = harness();
    const config = createWithRuntimeInspector(deps)({ resolver: {} }) as MetroConfigLike;
    const defaultResolve = vi.fn();
    config.resolver?.resolveRequest?.(context("/x/y.js", defaultResolve), "react", "ios");
    expect(defaultResolve).toHaveBeenCalledWith(
      expect.objectContaining({ originModulePath: path.join(process.cwd(), "index.js") }),
      "react",
      "ios"
    );
  });

  it("returns a new config and does not mutate the input", () => {
    const { deps } = harness({ rozeniteMetro: true, panel: true });
    const input = baseConfig();
    const resolverBefore = input.resolver;
    const serializerBefore = input.serializer;
    const snapshot = JSON.stringify(input);
    const withRI = createWithRuntimeInspector(deps);

    const plain = withRI(input);
    withRI(input, { rozenite: true });

    expect(plain).not.toBe(input);
    expect(input.resolver).toBe(resolverBefore);
    expect(input.serializer).toBe(serializerBefore);
    expect(input.resolver?.resolveRequest).toBeUndefined();
    expect(JSON.stringify(input)).toBe(snapshot);
    expect((plain as MetroConfigLike).watchFolders).toEqual(["/repo"]);
    expect((plain as MetroConfigLike).resolver?.sourceExts).toEqual(["ts", "tsx", "js"]);
  });
});

describe("withRuntimeInspector Rozenite", () => {
  it("is off by default: no Rozenite wrap, no panel redirect, serializer untouched", () => {
    const { deps, withRozenite, warnings } = harness({ rozeniteMetro: true, panel: true });
    const input = baseConfig();
    const config = createWithRuntimeInspector(deps)(input) as MetroConfigLike;

    expect(typeof config).toBe("object");
    expect(withRozenite).not.toHaveBeenCalled();
    expect(config.serializer).toBe(input.serializer);
    const defaultResolve = vi.fn(() => "sdk");
    expect(
      config.resolver?.resolveRequest?.(context("/app/App.tsx", defaultResolve), "@runtime-inspector/react-native", "ios")
    ).toBe("sdk");
    expect(warnings).toEqual([]);
  });

  it("is on when WITH_ROZENITE=true and @rozenite/metro resolves", async () => {
    process.env.WITH_ROZENITE = "true";
    const { deps, withRozenite } = harness({ rozeniteMetro: true, panel: true });
    const result = createWithRuntimeInspector(deps)(baseConfig());

    expect(typeof result).toBe("function");
    expect(withRozenite).toHaveBeenCalledTimes(1);
    expect(withRozenite.mock.calls[0]![1]).toEqual({
      enabled: true,
      include: ["@runtime-inspector/panel-rozenite"]
    });
    const resolved = await (result as () => Promise<MetroConfigLike>)();
    expect(resolved.rozenite).toBe(true);
  });

  it("explicit option wins over the environment", () => {
    process.env.WITH_ROZENITE = "true";
    const { deps, withRozenite } = harness({ rozeniteMetro: true, panel: true });
    expect(typeof createWithRuntimeInspector(deps)(baseConfig(), { rozenite: false })).toBe("object");
    expect(withRozenite).not.toHaveBeenCalled();

    delete process.env.WITH_ROZENITE;
    createWithRuntimeInspector(deps)(baseConfig(), { rozenite: true });
    expect(withRozenite).toHaveBeenCalledTimes(1);
  });

  it("warns and stays off when @rozenite/metro does not resolve", () => {
    const { deps, withRozenite, warnings } = harness({ rozeniteMetro: false, panel: true });
    const config = createWithRuntimeInspector(deps)(baseConfig(), { rozenite: true }) as MetroConfigLike;

    expect(typeof config).toBe("object");
    expect(withRozenite).not.toHaveBeenCalled();
    expect(config.serializer?.getModulesRunBeforeMainModule?.("index.js")).toEqual(["/InitializeCore.js"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@rozenite/metro");
  });

  it("auto-registers the panel: SDK imports go through the shim, which runs before the main module", () => {
    const { deps, withRozenite } = harness({ rozeniteMetro: true, panel: true });
    createWithRuntimeInspector(deps)(baseConfig(), { rozenite: true });
    const wrapped = withRozenite.mock.calls[0]![0] as MetroConfigLike;
    const resolveRequest = wrapped.resolver!.resolveRequest!;

    expect(wrapped.serializer?.getModulesRunBeforeMainModule?.("index.js")).toEqual([
      "/InitializeCore.js",
      rozeniteEntry
    ]);

    const appResolve = vi.fn();
    expect(resolveRequest(context("/app/App.tsx", appResolve), "@runtime-inspector/react-native", "ios")).toEqual({
      type: "sourceFile",
      filePath: rozeniteEntry
    });
    expect(appResolve).not.toHaveBeenCalled();

    // The panel's own SDK import is not redirected (no require cycle through the shim).
    const panelResolve = vi.fn(() => "real-sdk");
    expect(
      resolveRequest(
        context(`${panelRoot}/dist/react-native/react-native.js`, panelResolve),
        "@runtime-inspector/react-native",
        "ios"
      )
    ).toBe("real-sdk");

    // The shim's panel require resolves from the project root (it is not an SDK dependency).
    const shimResolve = vi.fn(() => "panel");
    resolveRequest(context(rozeniteEntry, shimResolve), "@runtime-inspector/panel-rozenite", "ios");
    expect(shimResolve).toHaveBeenCalledWith(
      expect.objectContaining({ originModulePath: "/app/index.js" }),
      "@runtime-inspector/panel-rozenite",
      "ios"
    );

    // Subpaths and the shim's relative SDK require are left alone.
    const otherResolve = vi.fn(() => "other");
    resolveRequest(context(rozeniteEntry, otherResolve), "./dist/index.js", "ios");
    resolveRequest(context("/app/metro.ts", otherResolve), "@runtime-inspector/react-native/metro", "ios");
    expect(otherResolve).toHaveBeenNthCalledWith(1, context(rozeniteEntry, otherResolve), "./dist/index.js", "ios");
  });

  it("keeps Rozenite but skips auto-registration (with a warning) when the panel does not resolve", () => {
    const { deps, withRozenite, warnings } = harness({ rozeniteMetro: true, panel: false });
    createWithRuntimeInspector(deps)(baseConfig(), { rozenite: true });
    const wrapped = withRozenite.mock.calls[0]![0] as MetroConfigLike;
    const defaultResolve = vi.fn(() => "sdk");

    expect(wrapped.serializer?.getModulesRunBeforeMainModule?.("index.js")).toEqual(["/InitializeCore.js"]);
    expect(
      wrapped.resolver!.resolveRequest!(context("/app/App.tsx", defaultResolve), "@runtime-inspector/react-native", "ios")
    ).toBe("sdk");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@runtime-inspector/panel-rozenite");
  });
});
