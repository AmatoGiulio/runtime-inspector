// Node-only Metro helper (`@runtime-inspector/react-native/metro`). Loaded by metro.config.js,
// never bundled into the app: it must not import React Native.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SDK_MODULE = "@runtime-inspector/react-native";
const ROZENITE_PANEL_MODULE = "@runtime-inspector/panel-rozenite";
const ROZENITE_METRO_MODULE = "@rozenite/metro";

/**
 * Modules that must exist once per bundle. pnpm can install a second physical copy of peer
 * dependencies (e.g. under packages/runtime-react-native/node_modules); mutables created by one
 * Reanimated copy are invisible to the other's runtime ("sv.addListener is not a function").
 */
const SINGLETON_MODULES = ["react", "react-native", "react-native-reanimated"];

export interface RuntimeInspectorMetroOptions {
  /**
   * Enables the React Native DevTools panel through Rozenite.
   * Defaults to `process.env.WITH_ROZENITE === "true"`.
   */
  rozenite?: boolean;
}

export type MetroResolveRequest = (
  context: MetroResolutionContext,
  moduleName: string,
  platform: string | null
) => unknown;

export interface MetroResolutionContext {
  originModulePath: string;
  resolveRequest: MetroResolveRequest;
  [key: string]: unknown;
}

/** The subset of a Metro config this helper reads; every other field is passed through untouched. */
export interface MetroConfigLike {
  projectRoot?: string;
  resolver?: {
    resolveRequest?: MetroResolveRequest | null;
    [key: string]: unknown;
  };
  serializer?: {
    getModulesRunBeforeMainModule?: (entryFilePath: string) => readonly string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** @internal Seams for tests; `withRuntimeInspector` uses Node resolution from the project root. */
export interface RuntimeInspectorMetroDeps {
  /** Absolute path of `request` resolved from `projectRoot`, or undefined when it does not resolve. */
  resolveFrom(projectRoot: string, request: string): string | undefined;
  /** Loads `request` as if required from `projectRoot`. */
  requireFrom(projectRoot: string, request: string): unknown;
  /** Absolute real path of the shim that stands in for the SDK when the DevTools panel is auto-registered. */
  rozeniteEntryPath(): string;
  warn(message: string): void;
}

type WithRozenite = (
  config: unknown,
  options: { enabled: boolean; include: string[] }
) => unknown;

const defaultDeps: RuntimeInspectorMetroDeps = {
  resolveFrom(projectRoot, request) {
    try {
      return createRequire(path.join(projectRoot, "package.json")).resolve(request);
    } catch {
      return undefined;
    }
  },
  requireFrom(projectRoot, request) {
    return createRequire(path.join(projectRoot, "package.json"))(request);
  },
  rozeniteEntryPath() {
    // dist/metro.js (and src/metro.ts) live one level below the package root.
    return realpath(path.resolve(__dirname, "..", "rozenite-entry.js"));
  },
  warn(message) {
    console.warn(message);
  }
};

/** @internal Builds `withRuntimeInspector` over injectable resolution (tests). */
export function createWithRuntimeInspector(deps: RuntimeInspectorMetroDeps) {
  return function withRuntimeInspector<T extends MetroConfigLike>(
    config: T,
    options: RuntimeInspectorMetroOptions = {}
  ): T | (() => Promise<T>) {
    const projectRoot = config.projectRoot ?? process.cwd();
    const rozeniteRequested = options.rozenite ?? process.env.WITH_ROZENITE === "true";

    let withRozenite: WithRozenite | undefined;
    let panelRoot: string | undefined;
    if (rozeniteRequested) {
      if (deps.resolveFrom(projectRoot, ROZENITE_METRO_MODULE)) {
        withRozenite = (deps.requireFrom(projectRoot, ROZENITE_METRO_MODULE) as {
          withRozenite: WithRozenite;
        }).withRozenite;
      } else {
        deps.warn(
          `[Runtime Inspector] Rozenite was requested but ${ROZENITE_METRO_MODULE} does not resolve from ${projectRoot}; continuing without React Native DevTools.`
        );
      }
      const panelPackageJson = deps.resolveFrom(projectRoot, `${ROZENITE_PANEL_MODULE}/package.json`);
      if (withRozenite && panelPackageJson) {
        panelRoot = realpath(path.dirname(panelPackageJson));
      } else if (withRozenite) {
        deps.warn(
          `[Runtime Inspector] ${ROZENITE_PANEL_MODULE} does not resolve from ${projectRoot}; the Runtime Inspector DevTools panel will not be registered.`
        );
      }
    }

    const singletonOrigin = path.join(projectRoot, "index.js");
    const fromProjectRoot = panelRoot
      ? [...SINGLETON_MODULES, ROZENITE_PANEL_MODULE]
      : SINGLETON_MODULES;
    const rozeniteEntry = panelRoot ? deps.rozeniteEntryPath() : undefined;
    const previousResolveRequest = config.resolver?.resolveRequest;

    const resolveRequest: MetroResolveRequest = (context, moduleName, platform) => {
      const resolve = previousResolveRequest ?? context.resolveRequest;
      // Auto-registration of the DevTools panel: every import of the SDK (except the panel's own)
      // goes through a shim that re-exports the SDK and requires the panel. This places the panel
      // in the dependency graph, which getModulesRunBeforeMainModule alone cannot do.
      if (
        rozeniteEntry &&
        panelRoot &&
        moduleName === SDK_MODULE &&
        !isInside(context.originModulePath, panelRoot)
      ) {
        return { type: "sourceFile", filePath: rozeniteEntry };
      }
      const isFromProjectRoot = fromProjectRoot.some(
        (name) => moduleName === name || moduleName.startsWith(`${name}/`)
      );
      if (isFromProjectRoot) {
        return resolve({ ...context, originModulePath: singletonOrigin }, moduleName, platform);
      }
      return resolve(context, moduleName, platform);
    };

    let next: T = {
      ...config,
      resolver: { ...config.resolver, resolveRequest }
    };

    if (rozeniteEntry) {
      const previousRunBefore = config.serializer?.getModulesRunBeforeMainModule;
      next = {
        ...next,
        serializer: {
          ...config.serializer,
          // Metro runs these only when they are in the graph; the SDK redirect above ensures that.
          getModulesRunBeforeMainModule: (entryFilePath: string) => [
            ...(previousRunBefore?.(entryFilePath) ?? []),
            rozeniteEntry
          ]
        }
      };
    }

    if (!withRozenite) return next;
    return withRozenite(next, {
      enabled: true,
      include: [ROZENITE_PANEL_MODULE]
    }) as () => Promise<T>;
  };
}

/**
 * Wraps an Expo / React Native Metro config for Runtime Inspector:
 * - resolves react, react-native and react-native-reanimated once, from the project root;
 * - with Rozenite (`options.rozenite`, default `WITH_ROZENITE=true`), enables React Native DevTools
 *   and registers the Runtime Inspector panel without an import in the app.
 *
 * Returns a new config (the input is not mutated), or Rozenite's async config function.
 */
export const withRuntimeInspector = createWithRuntimeInspector(defaultDeps);

function isInside(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realpath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}
