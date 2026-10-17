import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BABEL_PLUGIN,
  addBabelPlugin,
  detectPackageManager,
  expoBabelConfig,
  expoMetroConfig,
  formatDiff,
  installCommands,
  runInit,
  runInitCommand,
  wrapMetroConfig
} from "./init";

const METRO_REQUIRE = 'const { withRuntimeInspector } = require("@runtime-inspector/react-native/metro");';

describe("addBabelPlugin", () => {
  it("function shape with a plugins array: inserts before the Reanimated plugin", () => {
    const code = [
      "module.exports = function (api) {",
      "  api.cache(true);",
      "  return {",
      '    presets: ["babel-preset-expo"],',
      "    plugins: [",
      '      "some-plugin",',
      '      "react-native-reanimated/plugin"',
      "    ]",
      "  };",
      "};",
      ""
    ].join("\n");
    const result = addBabelPlugin(code);
    expect(result).toEqual({
      kind: "updated",
      code: code.replace(
        '      "react-native-reanimated/plugin"',
        `      "${BABEL_PLUGIN}",\n      "react-native-reanimated/plugin"`
      )
    });
  });

  it("inserts before a Reanimated plugin given as [name, options] on one line", () => {
    const code = `module.exports = { presets: ["x"], plugins: ["a", ["react-native-reanimated/plugin", {}]] };\n`;
    const result = addBabelPlugin(code);
    expect(result).toEqual({
      kind: "updated",
      code: `module.exports = { presets: ["x"], plugins: ["a", "${BABEL_PLUGIN}", ["react-native-reanimated/plugin", {}]] };\n`
    });
  });

  it("function shape without plugins: adds a plugins property after the last property", () => {
    const code = [
      "module.exports = function (api) {",
      "  api.cache(true);",
      "  return {",
      "    presets: ['babel-preset-expo'],",
      "  };",
      "};",
      ""
    ].join("\n");
    const result = addBabelPlugin(code);
    expect(result).toEqual({
      kind: "updated",
      code: code.replace(
        "    presets: ['babel-preset-expo'],",
        `    presets: ['babel-preset-expo'],\n    plugins: ['${BABEL_PLUGIN}'],`
      )
    });
  });

  it("arrow shape returning an object", () => {
    const code = `module.exports = (api) => ({ presets: ["babel-preset-expo"] });\n`;
    expect(addBabelPlugin(code)).toEqual({
      kind: "updated",
      code: `module.exports = (api) => ({ presets: ["babel-preset-expo"], plugins: ["${BABEL_PLUGIN}"] });\n`
    });
  });

  it("object shape without plugins (bare React Native default)", () => {
    const code = ["module.exports = {", "  presets: ['module:@react-native/babel-preset'],", "};", ""].join("\n");
    expect(addBabelPlugin(code)).toEqual({
      kind: "updated",
      code: [
        "module.exports = {",
        "  presets: ['module:@react-native/babel-preset'],",
        `  plugins: ['${BABEL_PLUGIN}'],`,
        "};",
        ""
      ].join("\n")
    });
  });

  it("object shape with a plugins array and no Reanimated: appends", () => {
    const code = ["module.exports = {", '  presets: ["p"],', "  plugins: [", '    "a"', "  ]", "};", ""].join("\n");
    expect(addBabelPlugin(code)).toEqual({
      kind: "updated",
      code: code.replace('    "a"', `    "a",\n    "${BABEL_PLUGIN}"`)
    });
  });

  it("object shape with an empty plugins array", () => {
    const code = `module.exports = { presets: ["p"], plugins: [] };\n`;
    expect(addBabelPlugin(code)).toEqual({
      kind: "updated",
      code: `module.exports = { presets: ["p"], plugins: ["${BABEL_PLUGIN}"] };\n`
    });
  });

  it("is idempotent: already present (string or [name, options]) is unchanged", () => {
    expect(addBabelPlugin(`module.exports = { plugins: ["${BABEL_PLUGIN}", "react-native-reanimated/plugin"] };`)).toEqual({
      kind: "unchanged"
    });
    expect(addBabelPlugin(`module.exports = { plugins: [["${BABEL_PLUGIN}", {}]] };`)).toEqual({ kind: "unchanged" });

    const once = addBabelPlugin(`module.exports = { presets: ["p"] };`);
    expect(once.kind).toBe("updated");
    expect(addBabelPlugin((once as { code: string }).code)).toEqual({ kind: "unchanged" });
  });

  it("other shapes need a manual step naming the line to add", () => {
    const shapes = [
      `const config = { presets: ["p"] };\nmodule.exports = config;\n`,
      `module.exports = { plugins: getPlugins() };\n`,
      `export default { presets: ["p"] };\n`,
      `module.exports = function (api) { if (x) return { a: 1 }; return { b: 2 }; };\n`,
      `this is not javascript`
    ];
    for (const code of shapes) {
      const result = addBabelPlugin(code);
      expect(result.kind).toBe("manual");
      expect((result as { reason: string }).reason).toContain(`"${BABEL_PLUGIN}"`);
    }
  });
});

describe("wrapMetroConfig", () => {
  it("wraps the export and adds the require after the last top-level require", () => {
    const code = [
      'const { getDefaultConfig } = require("expo/metro-config");',
      'const path = require("path");',
      "",
      "const config = getDefaultConfig(__dirname);",
      "",
      "module.exports = config;",
      ""
    ].join("\n");
    expect(wrapMetroConfig(code)).toEqual({
      kind: "updated",
      code: [
        'const { getDefaultConfig } = require("expo/metro-config");',
        'const path = require("path");',
        METRO_REQUIRE,
        "",
        "const config = getDefaultConfig(__dirname);",
        "",
        "module.exports = withRuntimeInspector(config);",
        ""
      ].join("\n")
    });
  });

  it("wraps a multi-line call expression and matches quote/semicolon style", () => {
    const code = [
      "const { withX } = require('x')",
      "module.exports = withX(config, {",
      "  enabled: true",
      "})",
      ""
    ].join("\n");
    expect(wrapMetroConfig(code)).toEqual({
      kind: "updated",
      code: [
        "const { withX } = require('x')",
        "const { withRuntimeInspector } = require('@runtime-inspector/react-native/metro')",
        "module.exports = withRuntimeInspector(withX(config, {",
        "  enabled: true",
        "}))",
        ""
      ].join("\n")
    });
  });

  it("puts the require at the top when the file has no requires", () => {
    const code = `module.exports = { resolver: {} };\n`;
    expect(wrapMetroConfig(code)).toEqual({
      kind: "updated",
      code: `${METRO_REQUIRE}\nmodule.exports = withRuntimeInspector({ resolver: {} });\n`
    });
  });

  it("does not duplicate an existing require", () => {
    const code = `${METRO_REQUIRE}\nmodule.exports = config;\n`;
    expect(wrapMetroConfig(code)).toEqual({
      kind: "updated",
      code: `${METRO_REQUIRE}\nmodule.exports = withRuntimeInspector(config);\n`
    });
  });

  it("is idempotent", () => {
    const once = wrapMetroConfig(`const a = require("a");\nmodule.exports = a;\n`);
    expect(once.kind).toBe("updated");
    expect(wrapMetroConfig((once as { code: string }).code)).toEqual({ kind: "unchanged" });
    expect(
      wrapMetroConfig(`${METRO_REQUIRE}\nconst config = withRuntimeInspector(base);\nmodule.exports = config;\n`)
    ).toEqual({ kind: "unchanged" });
  });

  it("ESM, function configs and unparsable files need a manual step", () => {
    const shapes = [
      `import { getDefaultConfig } from "expo/metro-config";\nexport default getDefaultConfig(".");\n`,
      `module.exports = async () => ({ resolver: {} });\n`,
      `const config = {};\n`,
      `module.exports = {`
    ];
    for (const code of shapes) {
      const result = wrapMetroConfig(code);
      expect(result.kind).toBe("manual");
      expect((result as { reason: string }).reason).toContain("withRuntimeInspector");
    }
  });
});

describe("package helpers", () => {
  it("detects the package manager from the nearest lockfile, walking up", () => {
    const files = new Set(["/repo/pnpm-lock.yaml", "/repo/apps/b/yarn.lock"]);
    const exists = (path: string) => files.has(path);
    expect(detectPackageManager("/repo/apps/a", exists)).toBe("pnpm");
    expect(detectPackageManager("/repo/apps/b", exists)).toBe("yarn");
    expect(detectPackageManager("/elsewhere", exists)).toBe("npm");
    expect(detectPackageManager("/x", (path) => path === "/x/bun.lockb")).toBe("bun");
  });

  it("prints exact install commands for missing packages only", () => {
    expect(installCommands("pnpm", { runtime: true, babelPlugin: true })).toEqual([
      "pnpm add @runtime-inspector/react-native",
      "pnpm add -D @runtime-inspector/babel-plugin"
    ]);
    expect(installCommands("npm", { runtime: false, babelPlugin: true })).toEqual([
      "npm install --save-dev @runtime-inspector/babel-plugin"
    ]);
    expect(installCommands("yarn", { runtime: true, babelPlugin: false })).toEqual([
      "yarn add @runtime-inspector/react-native"
    ]);
    expect(installCommands("bun", { runtime: false, babelPlugin: false })).toEqual([]);
    expect(installCommands("npm", { runtime: false, babelPlugin: true, cli: true, babelPresetExpo: true })).toEqual([
      "npm install --save-dev @runtime-inspector/babel-plugin @runtime-inspector/cli",
      "npx expo install babel-preset-expo"
    ]);
  });

  it("formats a new-file diff and a changed-file diff", () => {
    expect(formatDiff("a.js", undefined, "x\ny\n")).toBe("+++ a.js (new file)\n+x\n+y");
    expect(formatDiff("a.js", "1\n2\n3\n4\n5\n6\n", "1\n2\n3\nfour\n5\n6\n")).toBe(
      ["--- a.js", "+++ a.js", "@@", " 2", " 3", "-4", "+four", " 5", " 6"].join("\n")
    );
  });
});

describe("runInit", () => {
  let dir: string;
  let lines: string[];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ri-init-"));
    lines = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePackage(pkg: object) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  }

  function read(file: string) {
    return readFileSync(join(dir, file), "utf-8");
  }

  it("fails with a clear message when the project is not a React Native app", () => {
    writePackage({ dependencies: { react: "18" } });
    const result = runInit({ cwd: dir, log });
    expect(result.exitCode).toBe(1);
    expect(lines.join("\n")).toContain('no "react-native" or "expo" dependency');
  });

  it("fails when there is no package.json", () => {
    expect(runInit({ cwd: dir, log }).exitCode).toBe(1);
    expect(lines.join("\n")).toContain("No package.json");
  });

  it("creates the standard Expo babel and metro configs when missing", () => {
    writePackage({ dependencies: { expo: "52", "react-native-reanimated": "3" } });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const result = runInit({ cwd: dir, log });

    expect(result.exitCode).toBe(0);
    expect(read("babel.config.js")).toBe(expoBabelConfig(true));
    expect(read("babel.config.js")).toContain(`"${BABEL_PLUGIN}",\n      "react-native-reanimated/plugin"`);
    expect(read("metro.config.js")).toBe(expoMetroConfig());
    expect(read("metro.config.js")).toContain(
      "module.exports = withRuntimeInspector(getDefaultConfig(__dirname));"
    );
    expect(result.steps).toEqual([
      { step: "babel.config.js", status: "updated", detail: "created" },
      { step: "metro.config.js", status: "updated", detail: "created" },
      {
        step: "dependencies",
        status: "manual step needed",
        detail:
          "run pnpm add @runtime-inspector/react-native && pnpm add -D @runtime-inspector/babel-plugin @runtime-inspector/cli && npx expo install babel-preset-expo"
      }
    ]);
    const output = lines.join("\n");
    expect(output).toContain("npx runtime-inspector dev");
    expect(output).toContain("npx expo start");
    expect(output).toContain("panel URL");
  });

  it("does not ask for babel-preset-expo when the app already lists it or keeps its own babel config", () => {
    writePackage({
      dependencies: { expo: "58", "@runtime-inspector/react-native": "0.1" },
      devDependencies: { [BABEL_PLUGIN]: "0.1", "@runtime-inspector/cli": "0.1", "babel-preset-expo": "58" }
    });
    expect(runInit({ cwd: dir, log }).steps.at(-1)).toEqual({ step: "dependencies", status: "already set up" });

    rmSync(join(dir, "babel.config.js"));
    writePackage({ dependencies: { expo: "58" } });
    writeFileSync(join(dir, "babel.config.js"), 'module.exports = { presets: ["babel-preset-expo"] };\n');
    expect(runInit({ cwd: dir, log }).steps.at(-1)?.detail).not.toContain("babel-preset-expo");
  });

  it("creates the Expo babel config without Reanimated when it is not a dependency", () => {
    writePackage({ dependencies: { expo: "52" } });
    runInit({ cwd: dir, log });
    expect(read("babel.config.js")).toBe(expoBabelConfig(false));
    expect(read("babel.config.js")).not.toContain("reanimated");
  });

  it("edits existing configs, then reports already set up on a second run", () => {
    writePackage({
      dependencies: { "react-native": "0.76", "@runtime-inspector/react-native": "0.1" },
      devDependencies: { [BABEL_PLUGIN]: "0.1", "@runtime-inspector/cli": "0.1" }
    });
    writeFileSync(join(dir, "babel.config.js"), `module.exports = { presets: ["module:@react-native/babel-preset"] };\n`);
    writeFileSync(
      join(dir, "metro.config.js"),
      `const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), {});\n`
    );

    const first = runInit({ cwd: dir, log });
    expect(first.steps.map((step) => step.status)).toEqual(["updated", "updated", "already set up"]);
    expect(read("babel.config.js")).toContain(`plugins: ["${BABEL_PLUGIN}"]`);
    expect(read("metro.config.js")).toContain("module.exports = withRuntimeInspector(mergeConfig(");
    expect(lines.join("\n")).toContain("npx react-native start");

    const second = runInit({ cwd: dir, log });
    expect(second.steps.map((step) => step.status)).toEqual(["already set up", "already set up", "already set up"]);
  });

  it("reports manual steps for unsupported shapes and non-Expo missing files", () => {
    writePackage({ dependencies: { "react-native": "0.76" } });
    writeFileSync(join(dir, "babel.config.js"), `const c = { presets: [] };\nmodule.exports = c;\n`);
    writeFileSync(join(dir, "metro.config.mjs"), `export default {};\n`);

    const result = runInit({ cwd: dir, log });
    expect(result.exitCode).toBe(0);
    expect(result.steps[0]).toMatchObject({ step: "babel.config.js", status: "manual step needed" });
    expect(result.steps[1]).toMatchObject({ step: "metro.config.mjs", status: "manual step needed" });
    expect(result.steps[1]!.detail).toContain("withRuntimeInspector");
    expect(read("babel.config.js")).toBe(`const c = { presets: [] };\nmodule.exports = c;\n`);
    expect(existsSync(join(dir, "metro.config.js"))).toBe(false);
    expect(lines.join("\n")).toContain("manual step needed");

    rmSync(join(dir, "metro.config.mjs"));
    const bare = runInit({ cwd: dir, log });
    expect(bare.steps[1]).toMatchObject({ step: "metro.config.js", status: "manual step needed" });
    expect(bare.steps[1]!.detail).toContain("metro.config.js not found");
  });

  it("--dry-run prints diffs and writes nothing", async () => {
    writePackage({ dependencies: { expo: "52" } });
    const babel = `module.exports = { presets: ["babel-preset-expo"] };\n`;
    writeFileSync(join(dir, "babel.config.js"), babel);
    const before = readdirSync(dir).sort();

    const exitCode = await runInitCommand(["--cwd", dir, "--dry-run"], log);
    expect(exitCode).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(read("babel.config.js")).toBe(babel);

    const output = lines.join("\n");
    expect(output).toContain("--- babel.config.js");
    expect(output).toContain(`+module.exports = { presets: ["babel-preset-expo"], plugins: ["${BABEL_PLUGIN}"] };`);
    expect(output).toContain("+++ metro.config.js (new file)");
    expect(output).toContain("dry run, not written");
  });

  it("rejects unknown options", async () => {
    expect(await runInitCommand(["--nope"], log)).toBe(1);
    expect(lines.join("\n")).toContain("Usage: runtime-inspector init");
  });
});
