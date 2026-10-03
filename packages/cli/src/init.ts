import { parse as babelParse } from "@babel/parser";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * `runtime-inspector init`: wires a React Native app for Runtime Inspector in
 * one step (Babel plugin, Metro wrapper, install hints). Every step is
 * idempotent. The editing functions are pure (source in, source out) and
 * splice text at byte ranges located with @babel/parser, so the rest of the
 * user's file is left byte-for-byte identical.
 */

export const BABEL_PLUGIN = "@runtime-inspector/babel-plugin";
export const RUNTIME_PACKAGE = "@runtime-inspector/react-native";
export const METRO_MODULE = "@runtime-inspector/react-native/metro";
const METRO_WRAPPER = "withRuntimeInspector";
/** Plugins that must stay last in the Babel plugin list. */
const LAST_PLUGINS = ["react-native-reanimated/plugin", "react-native-worklets/plugin"];

export type EditResult =
  | { kind: "updated"; code: string }
  | { kind: "unchanged" }
  | { kind: "manual"; reason: string };

/** Loose structural view of a Babel AST node (no @babel/types dependency). */
type Node = { type: string; start: number; end: number; [key: string]: any };

// ---------------------------------------------------------------------------
// Babel config
// ---------------------------------------------------------------------------

export const BABEL_MANUAL_STEP =
  `add "${BABEL_PLUGIN}" to the plugins array in babel.config.js ` +
  `(before "react-native-reanimated/plugin" if present: Reanimated's plugin must stay last)`;

export function addBabelPlugin(code: string): EditResult {
  const manual: EditResult = { kind: "manual", reason: BABEL_MANUAL_STEP };
  const program = parseProgram(code);
  if (!program || isEsm(program)) return manual;

  const exportsList = findModuleExports(program);
  if (exportsList.length !== 1) return manual;
  const config = configObjectOf(exportsList[0]!.right);
  if (!config) return manual;

  const quote = detectQuote(program);
  const literal = `${quote}${BABEL_PLUGIN}${quote}`;
  const properties: Node[] = config.properties;
  const pluginsProperty = properties.find((property) => propertyName(property) === "plugins");

  if (pluginsProperty) {
    if (pluginsProperty.type !== "ObjectProperty" || pluginsProperty.value.type !== "ArrayExpression") {
      return manual;
    }
    const array: Node = pluginsProperty.value;
    const elements = (array.elements as Array<Node | null>).filter((element): element is Node => element !== null);
    if (elements.some((element) => pluginName(element) === BABEL_PLUGIN)) {
      return { kind: "unchanged" };
    }

    const mustStayLast = elements.find((element) => LAST_PLUGINS.includes(pluginName(element) ?? ""));
    if (mustStayLast) {
      const indent = lineIndent(code, mustStayLast.start);
      const insertion = indent !== undefined ? `${literal},\n${indent}` : `${literal}, `;
      return updated(splice(code, mustStayLast.start, mustStayLast.start, insertion));
    }

    if (elements.length === 0) {
      return updated(splice(code, array.start, array.end, `[${literal}]`));
    }
    const last = elements[elements.length - 1]!;
    const indent = lineIndent(code, last.start);
    const insertion = indent !== undefined ? `,\n${indent}${literal}` : `, ${literal}`;
    return updated(splice(code, last.end, last.end, insertion));
  }

  const pluginsEntry = `plugins: [${literal}]`;
  if (properties.length === 0) {
    return updated(splice(code, config.start, config.end, `{ ${pluginsEntry} }`));
  }
  const last = properties[properties.length - 1]!;
  const indent = lineIndent(code, last.start);
  const insertion = indent !== undefined ? `,\n${indent}${pluginsEntry}` : `, ${pluginsEntry}`;
  return updated(splice(code, last.end, last.end, insertion));
}

export function expoBabelConfig(withReanimated: boolean): string {
  const plugins = [`"${BABEL_PLUGIN}"`, ...(withReanimated ? [`"react-native-reanimated/plugin"`] : [])];
  return [
    "module.exports = function (api) {",
    "  api.cache(true);",
    "  return {",
    '    presets: ["babel-preset-expo"],',
    "    plugins: [",
    plugins.map((plugin) => `      ${plugin}`).join(",\n"),
    "    ]",
    "  };",
    "};",
    ""
  ].join("\n");
}

/** `module.exports = { … }`, `function (api) { …; return { … } }` or `(api) => ({ … })`. */
function configObjectOf(node: Node): Node | undefined {
  if (node.type === "ObjectExpression") return node;
  if (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") return undefined;
  const body: Node = node.body;
  if (body.type === "ObjectExpression") return body;
  if (body.type !== "BlockStatement") return undefined;
  const returns = collectReturns(body);
  if (returns.length !== 1) return undefined;
  const argument: Node | null = returns[0]!.argument;
  return argument?.type === "ObjectExpression" ? argument : undefined;
}

/** Return statements of a function body, not descending into nested functions. */
function collectReturns(body: Node): Node[] {
  const returns: Node[] = [];
  const visit = (node: Node) => {
    if (node.type === "ReturnStatement") returns.push(node);
    if (node !== body && /Function|ClassMethod|ObjectMethod/.test(node.type)) return;
    for (const child of childNodes(node)) visit(child);
  };
  visit(body);
  return returns;
}

function pluginName(element: Node): string | undefined {
  if (element.type === "StringLiteral") return element.value;
  if (element.type === "ArrayExpression") {
    const first: Node | null | undefined = element.elements[0];
    if (first?.type === "StringLiteral") return first.value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Metro config
// ---------------------------------------------------------------------------

const METRO_REQUIRE_LINE = `const { ${METRO_WRAPPER} } = require("${METRO_MODULE}");`;
export const METRO_MANUAL_STEP =
  `wrap the exported Metro config with ${METRO_WRAPPER}: ` +
  `${METRO_REQUIRE_LINE} then module.exports = ${METRO_WRAPPER}(config);`;

export function wrapMetroConfig(code: string): EditResult {
  const manual: EditResult = { kind: "manual", reason: METRO_MANUAL_STEP };
  const program = parseProgram(code);
  if (!program || isEsm(program)) return manual;
  if (containsCall(program, METRO_WRAPPER)) return { kind: "unchanged" };

  const exportsList = findModuleExports(program);
  if (exportsList.length !== 1) return manual;
  const { statement, right } = exportsList[0]!;
  // A function config (`module.exports = async () => …`) can't be wrapped as a value.
  if (right.type === "FunctionExpression" || right.type === "ArrowFunctionExpression") return manual;

  const edits: Array<{ start: number; end: number; text: string }> = [
    { start: right.start, end: right.end, text: `${METRO_WRAPPER}(${code.slice(right.start, right.end)})` }
  ];

  if (!requiresModule(program, METRO_MODULE)) {
    const quote = detectQuote(program);
    const semicolon = code.slice(statement.start, statement.end).trimEnd().endsWith(";") ? ";" : "";
    const line = `const { ${METRO_WRAPPER} } = require(${quote}${METRO_MODULE}${quote})${semicolon}`;
    const requires = (program.body as Node[]).filter(
      (candidate) => candidate.end <= statement.start && isRequireStatement(candidate)
    );
    const lastRequire = requires[requires.length - 1];
    if (lastRequire) {
      edits.push({ start: lastRequire.end, end: lastRequire.end, text: `\n${line}` });
    } else {
      const first: Node = program.body[0];
      edits.push({ start: first.start, end: first.start, text: `${line}\n` });
    }
  }

  let result = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = splice(result, edit.start, edit.end, edit.text);
  }
  return updated(result);
}

export function expoMetroConfig(): string {
  return [
    'const { getDefaultConfig } = require("expo/metro-config");',
    METRO_REQUIRE_LINE,
    "",
    `module.exports = ${METRO_WRAPPER}(getDefaultConfig(__dirname));`,
    ""
  ].join("\n");
}

function isRequireStatement(statement: Node): boolean {
  if (statement.type === "VariableDeclaration") {
    return (statement.declarations as Node[]).some((declarator) => isRequireExpression(declarator.init));
  }
  if (statement.type === "ExpressionStatement") return isRequireExpression(statement.expression);
  return false;
}

function isRequireExpression(node: Node | null | undefined): boolean {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "CallExpression" && current.callee.type === "Identifier" && current.callee.name === "require";
}

function requiresModule(program: Node, moduleName: string): boolean {
  let found = false;
  walk(program, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require" &&
      node.arguments[0]?.type === "StringLiteral" &&
      node.arguments[0].value === moduleName
    ) {
      found = true;
    }
  });
  return found;
}

function containsCall(root: Node, calleeName: string): boolean {
  let found = false;
  walk(root, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === calleeName) {
      found = true;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Package / dependencies
// ---------------------------------------------------------------------------

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface PackageInfo {
  isReactNative: boolean;
  isExpo: boolean;
  hasReanimated: boolean;
  hasRuntime: boolean;
  hasBabelPlugin: boolean;
}

export function inspectPackage(pkg: PackageJson): PackageInfo {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  return {
    isReactNative: has("react-native") || has("expo"),
    isExpo: has("expo"),
    hasReanimated: has("react-native-reanimated"),
    hasRuntime: has(RUNTIME_PACKAGE),
    hasBabelPlugin: has(BABEL_PLUGIN)
  };
}

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const LOCKFILES: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"]
];

/** Looks for a lockfile in `cwd` and its parents (monorepos keep it at the root). Defaults to npm. */
export function detectPackageManager(cwd: string, exists: (path: string) => boolean = existsSync): PackageManager {
  let dir = resolve(cwd);
  for (;;) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (exists(join(dir, lockfile))) return manager;
    }
    const parent = dirname(dir);
    if (parent === dir) return "npm";
    dir = parent;
  }
}

export function installCommands(
  manager: PackageManager,
  missing: { runtime: boolean; babelPlugin: boolean }
): string[] {
  const add = { pnpm: "pnpm add", yarn: "yarn add", bun: "bun add", npm: "npm install" }[manager];
  const addDev = { pnpm: "pnpm add -D", yarn: "yarn add -D", bun: "bun add --dev", npm: "npm install --save-dev" }[
    manager
  ];
  const commands: string[] = [];
  if (missing.runtime) commands.push(`${add} ${RUNTIME_PACKAGE}`);
  if (missing.babelPlugin) commands.push(`${addDev} ${BABEL_PLUGIN}`);
  return commands;
}

// ---------------------------------------------------------------------------
// Diff (dry run)
// ---------------------------------------------------------------------------

const DIFF_CONTEXT = 2;

/** Unified-ish line diff for `--dry-run`. `before` undefined means a new file. */
export function formatDiff(path: string, before: string | undefined, after: string): string {
  const afterLines = splitLines(after);
  if (before === undefined) {
    return [`+++ ${path} (new file)`, ...afterLines.map((line) => `+${line}`)].join("\n");
  }
  const beforeLines = splitLines(before);
  const n = beforeLines.length;
  const m = afterLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        beforeLines[i] === afterLines[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Array<{ mark: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && beforeLines[i] === afterLines[j]) {
      ops.push({ mark: " ", line: beforeLines[i]! });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ mark: "-", line: beforeLines[i]! });
      i += 1;
    } else {
      ops.push({ mark: "+", line: afterLines[j]! });
      j += 1;
    }
  }

  const keep = ops.map(() => false);
  ops.forEach((op, index) => {
    if (op.mark === " ") return;
    for (let k = Math.max(0, index - DIFF_CONTEXT); k <= Math.min(ops.length - 1, index + DIFF_CONTEXT); k += 1) {
      keep[k] = true;
    }
  });
  const output = [`--- ${path}`, `+++ ${path}`];
  let skipping = true;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipping = true;
      return;
    }
    if (skipping) output.push("@@");
    skipping = false;
    output.push(`${op.mark}${op.line}`);
  });
  return output.join("\n");
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Command (thin fs layer)
// ---------------------------------------------------------------------------

export type StepStatus = "updated" | "already set up" | "manual step needed";

export interface StepReport {
  step: string;
  status: StepStatus;
  detail?: string;
}

export interface InitOptions {
  cwd: string;
  dryRun?: boolean;
  log?(line: string): void;
}

export interface InitResult {
  exitCode: number;
  steps: StepReport[];
}

const BABEL_CONFIG_ALTERNATIVES = [
  "babel.config.cjs",
  "babel.config.mjs",
  "babel.config.cts",
  "babel.config.json",
  ".babelrc",
  ".babelrc.js",
  ".babelrc.json"
];
const METRO_CONFIG_ALTERNATIVES = ["metro.config.cjs", "metro.config.mjs", "metro.config.ts", "metro.config.cts", "metro.config.mts"];

export function runInit(options: InitOptions): InitResult {
  const log = options.log ?? ((line: string) => console.log(line));
  const cwd = resolve(options.cwd);
  const dryRun = options.dryRun ?? false;
  const steps: StepReport[] = [];

  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) {
    log(`No package.json in ${cwd}. Run \`runtime-inspector init\` inside your React Native app (or pass --cwd <dir>).`);
    return { exitCode: 1, steps };
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as PackageJson;
  } catch (error) {
    log(`Could not read ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1, steps };
  }
  const info = inspectPackage(pkg);
  if (!info.isReactNative) {
    log(
      `${cwd} is not a React Native app: package.json has no "react-native" or "expo" dependency. ` +
        "Run `runtime-inspector init` inside your app (or pass --cwd <dir>)."
    );
    return { exitCode: 1, steps };
  }

  const manager = detectPackageManager(cwd);
  log(`Runtime Inspector init: ${cwd} (${info.isExpo ? "Expo" : "React Native"} app, ${manager})`);
  if (dryRun) log("Dry run: showing changes, nothing is written.");

  const write = (file: string, before: string | undefined, after: string) => {
    const path = join(cwd, file);
    if (dryRun) {
      log("");
      log(formatDiff(file, before, after));
    } else {
      writeFileSync(path, after, "utf-8");
    }
  };

  // 1. Babel plugin.
  steps.push(
    configStep({
      cwd,
      file: "babel.config.js",
      alternatives: BABEL_CONFIG_ALTERNATIVES,
      edit: addBabelPlugin,
      create: info.isExpo ? () => expoBabelConfig(info.hasReanimated) : undefined,
      manualReason: BABEL_MANUAL_STEP,
      write
    })
  );

  // 2. Metro wrapper.
  steps.push(
    configStep({
      cwd,
      file: "metro.config.js",
      alternatives: METRO_CONFIG_ALTERNATIVES,
      edit: wrapMetroConfig,
      create: info.isExpo ? expoMetroConfig : undefined,
      manualReason: METRO_MANUAL_STEP,
      write
    })
  );

  // 3. Dependencies (never installed for the user).
  const commands = installCommands(manager, { runtime: !info.hasRuntime, babelPlugin: !info.hasBabelPlugin });
  steps.push(
    commands.length === 0
      ? { step: "dependencies", status: "already set up" }
      : { step: "dependencies", status: "manual step needed", detail: `run ${commands.join(" && ")}` }
  );

  log("");
  for (const report of steps) {
    if (report.status === "updated") {
      const notes = [report.detail, dryRun ? "dry run, not written" : undefined].filter(Boolean).join(", ");
      log(`  ${report.step}: updated${notes ? ` (${notes})` : ""}`);
    } else {
      log(`  ${report.step}: ${report.status}${report.detail ? `: ${report.detail}` : ""}`);
    }
  }

  log("");
  log("Next steps:");
  log("  1. runtime-inspector dev");
  log(`  2. Start the app: ${info.isExpo ? "npx expo start" : "npx react-native start"}`);
  log("  3. Open the Workbench (it reads the session file; no token to copy)");

  return { exitCode: 0, steps };
}

function configStep(options: {
  cwd: string;
  file: string;
  alternatives: string[];
  edit(code: string): EditResult;
  create: (() => string) | undefined;
  manualReason: string;
  write(file: string, before: string | undefined, after: string): void;
}): StepReport {
  const path = join(options.cwd, options.file);
  if (existsSync(path)) {
    const before = readFileSync(path, "utf-8");
    const result = options.edit(before);
    if (result.kind === "unchanged") return { step: options.file, status: "already set up" };
    if (result.kind === "manual") return { step: options.file, status: "manual step needed", detail: result.reason };
    options.write(options.file, before, result.code);
    return { step: options.file, status: "updated" };
  }

  const alternative = options.alternatives.find((file) => existsSync(join(options.cwd, file)));
  if (alternative) {
    return {
      step: alternative,
      status: "manual step needed",
      detail: options.manualReason.replace(options.file, alternative)
    };
  }
  if (!options.create) {
    return {
      step: options.file,
      status: "manual step needed",
      detail: `${options.file} not found; ${options.manualReason}`
    };
  }
  options.write(options.file, undefined, options.create());
  return { step: options.file, status: "updated", detail: "created" };
}

export const INIT_USAGE = "Usage: runtime-inspector init [--cwd <dir>] [--dry-run]";

/** Parses `init` argv (after the command name) and runs it. Returns the exit code. */
export async function runInitCommand(argv: string[], log?: (line: string) => void): Promise<number> {
  const print = log ?? ((line: string) => console.log(line));
  let cwd = process.cwd();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        print(INIT_USAGE);
        return 1;
      }
      cwd = resolve(value);
      index += 1;
    } else if (arg.startsWith("--cwd=")) {
      cwd = resolve(arg.slice("--cwd=".length));
    } else if (arg === "--help" || arg === "-h") {
      print(INIT_USAGE);
      return 0;
    } else {
      print(`Unknown option: ${arg}`);
      print(INIT_USAGE);
      return 1;
    }
  }
  return runInit({ cwd, dryRun, log: print }).exitCode;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------

function parseProgram(code: string): Node | undefined {
  try {
    const file = babelParse(code, { sourceType: "unambiguous" }) as unknown as Node;
    return file.program as Node;
  } catch {
    return undefined;
  }
}

function isEsm(program: Node): boolean {
  return (program.body as Node[]).some(
    (statement) =>
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportAllDeclaration"
  );
}

function findModuleExports(program: Node): Array<{ statement: Node; right: Node }> {
  const found: Array<{ statement: Node; right: Node }> = [];
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ExpressionStatement") continue;
    const expression: Node = statement.expression;
    if (expression.type !== "AssignmentExpression" || expression.operator !== "=") continue;
    const left: Node = expression.left;
    if (
      left.type === "MemberExpression" &&
      !left.computed &&
      left.object.type === "Identifier" &&
      left.object.name === "module" &&
      left.property.type === "Identifier" &&
      left.property.name === "exports"
    ) {
      found.push({ statement, right: expression.right });
    }
  }
  return found;
}

function propertyName(property: Node): string | undefined {
  if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") return undefined;
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "StringLiteral") return property.key.value;
  return undefined;
}

function detectQuote(program: Node): string {
  let quote: string | undefined;
  walk(program, (node) => {
    if (quote === undefined && node.type === "StringLiteral" && typeof node.extra?.raw === "string") {
      quote = node.extra.raw[0];
    }
  });
  return quote === "'" ? "'" : '"';
}

/** Indentation before `position` if it starts its own line, else undefined. */
function lineIndent(code: string, position: number): string | undefined {
  const lineStart = code.lastIndexOf("\n", position - 1) + 1;
  const prefix = code.slice(lineStart, position);
  return /^[ \t]*$/.test(prefix) && lineStart > 0 ? prefix : undefined;
}

function splice(code: string, start: number, end: number, text: string): string {
  return code.slice(0, start) + text + code.slice(end);
}

function updated(code: string): EditResult {
  return { kind: "updated", code };
}

const SKIP_KEYS = new Set(["loc", "extra", "leadingComments", "trailingComments", "innerComments", "comments"]);

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of childNodes(node)) walk(child, visit);
}

function childNodes(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const candidates: unknown[] = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && typeof (candidate as Node).type === "string") {
        children.push(candidate as Node);
      }
    }
  }
  return children;
}
