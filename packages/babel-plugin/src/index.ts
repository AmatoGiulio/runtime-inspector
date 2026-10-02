import type { ConfigAPI, NodePath, PluginObj, PluginPass } from "@babel/core";
import type * as BabelTypesNamespace from "@babel/types";
import type {
  AssignmentExpression,
  CallExpression,
  CommentBlock,
  CommentLine,
  Node,
  VariableDeclarator
} from "@babel/types";
import { relative, sep } from "node:path";
import { parseDirectiveComment, type ParsedDirective } from "./directive";

const HELPER_NAME = "__riInspect";
const ANIMATION_OBSERVER_HELPER_NAME = "__riObserveAnimation";
const SOURCE_MODULE = "@runtime-inspector/react-native";

/**
 * Structural anchor for a captured declaration (RFC 0004, Part 1). Carried in
 * the emitted meta as `source` so a later "Apply to code" pass can re-locate
 * the declaration without trusting stale line numbers.
 */
interface SourceAnchor {
  file: string;
  line: number;
  column: number;
  enclosure: string[];
  name: string;
  init: string;
}

/**
 * The Babel plugin entry function receives the classic API object, which
 * carries `env()`/`caller()` (typed by `ConfigAPI`) plus a `types` namespace
 * (the `@babel/types` builders) - the latter isn't part of `ConfigAPI` itself
 * but is always present at runtime, so it's added here explicitly.
 */
type BabelAPI = ConfigAPI & { types: typeof BabelTypesNamespace };

/**
 * Babel plugin implementing RFC 0002: an `// @inspect ...` directive comment
 * immediately preceding (or trailing) a `useSharedValue(...)` declaration
 * rewrites it into `__riInspect(useSharedValue(...), "name", { ...meta })`,
 * auto-importing the helper from `@runtime-inspector/react-native`.
 *
 * The transform only runs outside production (`api.env() !== "production"`);
 * in production builds the directive is left as an inert comment and the
 * code is untouched.
 */
export default function runtimeInspectorBabelPlugin(api: BabelAPI): PluginObj {
  const isProduction = api.env("production");

  return {
    name: "runtime-inspector-auto-binding",
    visitor: {
      Program(programPath, state) {
        if (isProduction) return;
        const stateBag = programPath as unknown as {
          _riHelperImported?: boolean;
          _riRuntimeHelpers?: Set<string>;
          _riInspectorSchemas?: Map<string, string>;
          _riAutoValueNames?: Set<string>;
          _riSkipAnimationInstrumentation?: boolean;
        };
        stateBag._riHelperImported = false;
        stateBag._riRuntimeHelpers = new Set();
        stateBag._riInspectorSchemas = new Map();
        stateBag._riAutoValueNames = new Set();
        stateBag._riSkipAnimationInstrumentation = shouldSkipAnimationInstrumentation(
          state.filename ?? state.file.opts.filename ?? undefined
        );
      },
      VariableDeclarator(path: NodePath<VariableDeclarator>, state: PluginPass) {
        if (isProduction) return;

        const init = path.node.init;
        const id = path.node.id;

        if (
          init?.type === "CallExpression" &&
          id.type === "Identifier" &&
          isUseInspectorCallee(init.callee)
        ) {
          const schemaArg = init.arguments[0];
          if (schemaArg?.type === "StringLiteral") {
            programState(path)._riInspectorSchemas?.set(id.name, schemaArg.value);
          }
        }

        if (!init || init.type !== "CallExpression") return;
        if (!isUseSharedValueCallee(init.callee)) return;
        if (id.type !== "Identifier") return;

        const directive = findDirective(path);
        if (!directive) return;

        const name = id.name;
        validateDirective(directive, init, name);

        const t = api.types;
        const label = directive.label ?? name;
        const metaProps: Array<[string, unknown]> = [];
        if (directive.min !== undefined) metaProps.push(["min", directive.min]);
        if (directive.max !== undefined) metaProps.push(["max", directive.max]);
        if (directive.step !== undefined) metaProps.push(["step", directive.step]);
        if (directive.unit !== undefined) metaProps.push(["unit", directive.unit]);
        metaProps.push(["label", label]);

        const metaProperties = metaProps.map(([key, value]) =>
          t.objectProperty(t.identifier(key), literalFor(t, value))
        );

        const anchor = buildSourceAnchor(path, state, name, init);
        if (anchor) {
          metaProperties.push(
            t.objectProperty(t.identifier("source"), sourceAnchorToObjectExpression(t, anchor))
          );
        }

        const metaObject = t.objectExpression(metaProperties);

        const call = t.callExpression(t.identifier(HELPER_NAME), [
          init,
          t.stringLiteral(name),
          metaObject
        ]);

        path.get("init").replaceWith(call);
        programState(path)._riAutoValueNames?.add(name);
        ensureHelperImport(path, state, api);
      },
      AssignmentExpression(path: NodePath<AssignmentExpression>, state: PluginPass) {
        if (isProduction) return;
        if (programState(path)._riSkipAnimationInstrumentation) return;
        if (path.node.operator !== "=") return;

        const target = animationAssignmentTarget(path.node.left, state);
        if (!target) return;

        const right = path.node.right;
        if (right.type !== "CallExpression") return;

        const animationKind = animationKindForCallee(right.callee);
        if (!animationKind) return;

        // First spike: preserve any user completion callback untouched. Reanimated's
        // Babel plugin owns callback workletization, so calls with a third argument
        // are deliberately left alone until callback composition is proven safe.
        if (right.arguments.length > 2 || right.arguments.length === 0) return;
        if (right.arguments.some((argument) => argument.type === "SpreadElement")) return;

        if (isInsideKnownWorkletContext(path)) return;

        const meta = buildAnimationMeta(path, state, target, animationKind, right, api);
        if (!meta) return;

        // Preserve the application's original Reanimated call exactly. Runtime
        // Inspector observes the animation object *after* Reanimated constructs it
        // and returns that same object unchanged.
        const originalAnimationCall = api.types.cloneNode(right, true);
        path.get("right").replaceWith(
          api.types.callExpression(api.types.identifier(ANIMATION_OBSERVER_HELPER_NAME), [
            originalAnimationCall,
            meta
          ])
        );
        ensureRuntimeHelperImport(path, ANIMATION_OBSERVER_HELPER_NAME, api);
      }
    }
  };
}

function isUseSharedValueCallee(callee: Node): boolean {
  if (callee.type === "Identifier") {
    return callee.name === "useSharedValue";
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" && callee.property.name === "useSharedValue";
  }
  return false;
}

function isUseInspectorCallee(callee: Node): boolean {
  if (callee.type === "Identifier") {
    return callee.name === "useInspector";
  }
  if (callee.type === "MemberExpression" && !callee.computed) {
    return callee.property.type === "Identifier" && callee.property.name === "useInspector";
  }
  return false;
}

function animationKindForCallee(callee: Node): "timing" | "spring" | undefined {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier"
        ? callee.property.name
        : undefined;

  if (name === "withTiming") return "timing";
  if (name === "withSpring") return "spring";
  return undefined;
}

function animationAssignmentTarget(
  left: AssignmentExpression["left"],
  state: PluginPass
): { target: string; root: string } | undefined {
  if (left.type !== "MemberExpression" || left.computed) return undefined;
  if (left.property.type !== "Identifier" || left.property.name !== "value") return undefined;
  if (left.start == null || left.end == null) return undefined;

  const source = state.file.code.slice(left.start, left.end);
  const target = source.replace(/\.value\s*$/, "");
  if (!target || target === source) return undefined;

  let object: Node = left.object;
  while (object.type === "MemberExpression" && !object.computed) {
    object = object.object;
  }
  if (object.type !== "Identifier") return undefined;

  return { target, root: object.name };
}

function buildAnimationMeta(
  path: NodePath<AssignmentExpression>,
  state: PluginPass,
  target: { target: string; root: string },
  animationKind: "timing" | "spring",
  animationCall: CallExpression,
  api: BabelAPI
) {
  const filename = state.filename ?? state.file.opts.filename ?? undefined;
  const rootDir = state.file.opts.root ?? state.file.opts.cwd ?? undefined;
  const loc = path.node.loc;
  if (!filename || !rootDir || !loc) return undefined;

  const file = relative(rootDir, filename).split(sep).join("/");
  const callsiteId = `${file}:${loc.start.line}:${loc.start.column}:${animationKind}:${target.target}`;
  const stateBag = programState(path);
  const schemaId =
    stateBag._riInspectorSchemas?.get(target.root) ??
    (stateBag._riAutoValueNames?.has(target.root) ? "auto" : undefined);

  const expression =
    path.node.right.start != null && path.node.right.end != null
      ? state.file.code.slice(path.node.right.start, path.node.right.end)
      : "";

  const t = api.types;
  const properties = [
    t.objectProperty(t.identifier("callsiteId"), t.stringLiteral(callsiteId)),
    t.objectProperty(t.identifier("target"), t.stringLiteral(target.target)),
    t.objectProperty(t.identifier("animationKind"), t.stringLiteral(animationKind)),
    t.objectProperty(
      t.identifier("source"),
      t.objectExpression([
        t.objectProperty(t.identifier("file"), t.stringLiteral(file)),
        t.objectProperty(t.identifier("line"), t.numericLiteral(loc.start.line)),
        t.objectProperty(t.identifier("column"), t.numericLiteral(loc.start.column)),
        t.objectProperty(
          t.identifier("enclosure"),
          t.arrayExpression(collectEnclosure(path).map((entry) => t.stringLiteral(entry)))
        ),
        t.objectProperty(t.identifier("expression"), t.stringLiteral(expression))
      ])
    )
  ];

  const toValue = staticPrimitive(animationCall.arguments[0]);
  if (toValue !== undefined) {
    properties.push(
      t.objectProperty(t.identifier("toValue"), primitiveLiteral(t, toValue))
    );
  }

  const staticConfig = staticConfigObject(animationCall.arguments[1]);
  if (staticConfig) {
    properties.push(
      t.objectProperty(
        t.identifier("config"),
        t.objectExpression(
          Object.entries(staticConfig).map(([key, value]) =>
            t.objectProperty(t.identifier(key), primitiveLiteral(t, value))
          )
        )
      )
    );
  }

  const configControlId = resolveConfigControlId(
    path,
    animationCall.arguments[1],
    stateBag._riInspectorSchemas
  );
  if (configControlId) {
    properties.push(
      t.objectProperty(t.identifier("configControlId"), t.stringLiteral(configControlId))
    );
  }

  if (schemaId) {
    properties.splice(
      1,
      0,
      t.objectProperty(t.identifier("schemaId"), t.stringLiteral(schemaId))
    );
  }

  return t.objectExpression(properties);
}

type PrimitiveMetaValue = string | number | boolean | null;

function primitiveLiteral(
  t: BabelAPI["types"],
  value: PrimitiveMetaValue
) {
  if (value === null) return t.nullLiteral();
  if (typeof value === "number") return t.numericLiteral(value);
  if (typeof value === "boolean") return t.booleanLiteral(value);
  return t.stringLiteral(value);
}

function staticPrimitive(node: Node | null | undefined): PrimitiveMetaValue | undefined {
  if (!node) return undefined;
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "BooleanLiteral") return node.value;
  if (node.type === "NullLiteral") return null;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "NumericLiteral"
  ) {
    return -node.argument.value;
  }
  return undefined;
}

function staticConfigObject(
  node: Node | null | undefined
): Record<string, PrimitiveMetaValue> | undefined {
  if (!node || node.type !== "ObjectExpression") return undefined;

  const config: Record<string, PrimitiveMetaValue> = {};
  for (const property of node.properties) {
    if (property.type !== "ObjectProperty" || property.computed) continue;

    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "StringLiteral"
          ? property.key.value
          : undefined;
    if (!key) continue;

    const value = staticPrimitive(property.value as Node);
    if (value !== undefined) {
      config[key] = value;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function resolveConfigControlId(
  path: NodePath,
  node: Node | null | undefined,
  inspectorSchemas: Map<string, string> | undefined,
  seen = new Set<string>()
): string | undefined {
  if (!node) return undefined;

  if (node.type === "MemberExpression" && !node.computed) {
    const parts = memberExpressionParts(node);
    if (parts && parts.length === 3 && parts[2] === "value") {
      const [root, controlId] = parts;
      if (inspectorSchemas?.has(root)) {
        return controlId;
      }
    }
    return undefined;
  }

  if (node.type !== "Identifier" || seen.has(node.name)) return undefined;
  seen.add(node.name);

  const binding = path.scope.getBinding(node.name);
  const bindingPath = binding?.path;
  if (!bindingPath) return undefined;

  if (bindingPath.isVariableDeclarator()) {
    return resolveConfigControlId(
      bindingPath,
      bindingPath.node.init as Node | null | undefined,
      inspectorSchemas,
      seen
    );
  }

  const declarator = bindingPath.findParent((candidate) => candidate.isVariableDeclarator());
  if (declarator?.isVariableDeclarator()) {
    return resolveConfigControlId(
      declarator,
      declarator.node.init as Node | null | undefined,
      inspectorSchemas,
      seen
    );
  }

  return undefined;
}

function memberExpressionParts(node: Node): string[] | undefined {
  if (node.type === "Identifier") return [node.name];
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  if (node.property.type !== "Identifier") return undefined;

  const objectParts = memberExpressionParts(node.object);
  return objectParts ? [...objectParts, node.property.name] : undefined;
}

const knownAutoWorkletCalls = new Set([
  "useAnimatedStyle",
  "useAnimatedProps",
  "useDerivedValue",
  "useAnimatedReaction",
  "useAnimatedScrollHandler",
  "useFrameCallback"
]);

const knownGestureWorkletMethods = new Set([
  "onBegin",
  "onStart",
  "onUpdate",
  "onChange",
  "onEnd",
  "onFinalize",
  "onTouchesDown",
  "onTouchesMove",
  "onTouchesUp",
  "onTouchesCancelled"
]);

function isInsideKnownWorkletContext(path: NodePath): boolean {
  let current: NodePath | null = path.parentPath;

  while (current) {
    if (
      current.isFunctionExpression() ||
      current.isArrowFunctionExpression() ||
      current.isFunctionDeclaration()
    ) {
      if (
        current.node.body.type === "BlockStatement" &&
        (current.node.body.directives ?? []).some(
          (directive) => directive.value.value === "worklet"
        )
      ) {
        return true;
      }

      const parent = current.parentPath;
      if (parent?.isCallExpression()) {
        const callee = parent.node.callee;
        if (
          callee.type === "Identifier" &&
          knownAutoWorkletCalls.has(callee.name)
        ) {
          return true;
        }
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          knownGestureWorkletMethods.has(callee.property.name)
        ) {
          return true;
        }
      }
    }

    current = current.parentPath;
  }

  return false;
}

function programState(path: NodePath) {
  const program = path.findParent((candidate) => candidate.isProgram());
  if (!program || !program.isProgram()) {
    throw new Error("@runtime-inspector/babel-plugin: could not resolve Program path.");
  }
  return program as unknown as {
    _riHelperImported?: boolean;
    _riRuntimeHelpers?: Set<string>;
    _riInspectorSchemas?: Map<string, string>;
    _riAutoValueNames?: Set<string>;
    _riSkipAnimationInstrumentation?: boolean;
  };
}

function shouldSkipAnimationInstrumentation(filename: string | undefined): boolean {
  if (!filename) return false;
  const normalized = filename.split(sep).join("/");
  return (
    normalized.includes("/packages/runtime-react-native/") ||
    normalized.includes("/node_modules/@runtime-inspector/react-native/")
  );
}


function literalFor(t: BabelAPI["types"], value: unknown) {
  if (typeof value === "number") return t.numericLiteral(value);
  return t.stringLiteral(String(value));
}

/**
 * Builds the `source` anchor for a captured `useSharedValue` declaration
 * (RFC 0004, Part 1). Returns `undefined` whenever any required piece of
 * information (filename, root/cwd, loc, or the first call argument) is
 * unavailable - a partial anchor is never emitted.
 */
function buildSourceAnchor(
  path: NodePath<VariableDeclarator>,
  state: PluginPass,
  name: string,
  init: CallExpression
): SourceAnchor | undefined {
  const filename = state.filename ?? state.file.opts.filename ?? undefined;
  if (!filename) return undefined;

  const root = state.file.opts.root ?? state.file.opts.cwd ?? undefined;
  if (!root) return undefined;

  const loc = path.node.loc;
  if (!loc) return undefined;

  const firstArg = init.arguments[0];
  if (!firstArg || firstArg.start == null || firstArg.end == null) return undefined;

  const code = state.file.code;
  const initText = code.slice(firstArg.start, firstArg.end);

  const file = relative(root, filename).split(sep).join("/");

  return {
    file,
    line: loc.start.line,
    column: loc.start.column,
    enclosure: collectEnclosure(path),
    name,
    init: initText
  };
}

/**
 * Walks the ancestor chain from the declaration outward, collecting the
 * names of enclosing named functions/components: `FunctionDeclaration`s with
 * an `id`, and `FunctionExpression`/`ArrowFunctionExpression`s assigned to a
 * named `VariableDeclarator`. Anonymous functions are skipped entirely (no
 * placeholder is invented). Returned outermost-first.
 */
function collectEnclosure(path: NodePath): string[] {
  const names: string[] = [];
  let current: NodePath | null = path.parentPath;

  while (current) {
    if (current.isFunctionDeclaration() && current.node.id?.name) {
      names.push(current.node.id.name);
    } else if (current.isFunctionExpression() || current.isArrowFunctionExpression()) {
      const parent = current.parentPath;
      if (parent && parent.isVariableDeclarator() && parent.node.id.type === "Identifier") {
        names.push(parent.node.id.name);
      }
    }
    current = current.parentPath;
  }

  return names.reverse();
}

function sourceAnchorToObjectExpression(t: BabelAPI["types"], anchor: SourceAnchor) {
  return t.objectExpression([
    t.objectProperty(t.identifier("file"), t.stringLiteral(anchor.file)),
    t.objectProperty(t.identifier("line"), t.numericLiteral(anchor.line)),
    t.objectProperty(t.identifier("column"), t.numericLiteral(anchor.column)),
    t.objectProperty(
      t.identifier("enclosure"),
      t.arrayExpression(anchor.enclosure.map((entry) => t.stringLiteral(entry)))
    ),
    t.objectProperty(t.identifier("name"), t.stringLiteral(anchor.name)),
    t.objectProperty(t.identifier("init"), t.stringLiteral(anchor.init))
  ]);
}

/**
 * Looks for an `@inspect` directive in the leading comments of the enclosing
 * `VariableDeclaration` statement, or in its trailing comments (same-line
 * trailing comment variant).
 */
function findDirective(path: NodePath<VariableDeclarator>): ParsedDirective | undefined {
  const statement = path.parentPath?.parentPath ?? null; // VariableDeclaration -> statement
  const declarationNode = path.parent as Node;

  const leading = (declarationNode.leadingComments ?? []) as Array<CommentLine | CommentBlock>;
  for (const comment of leading) {
    const parsed = parseDirectiveComment(comment.value);
    if (parsed) return parsed;
  }

  const trailing = (declarationNode.trailingComments ?? []) as Array<CommentLine | CommentBlock>;
  for (const comment of trailing) {
    const parsed = parseDirectiveComment(comment.value);
    if (parsed) return parsed;
  }

  // Some parsers attach the leading comment to the outer statement rather
  // than the declaration node itself - check that too.
  if (statement && statement.node) {
    const statementLeading = ((statement.node as Node).leadingComments ?? []) as Array<
      CommentLine | CommentBlock
    >;
    for (const comment of statementLeading) {
      const parsed = parseDirectiveComment(comment.value);
      if (parsed) return parsed;
    }
    const statementTrailing = ((statement.node as Node).trailingComments ?? []) as Array<
      CommentLine | CommentBlock
    >;
    for (const comment of statementTrailing) {
      const parsed = parseDirectiveComment(comment.value);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

function validateDirective(
  directive: ParsedDirective,
  init: { arguments: Node[] },
  name: string
): void {
  const firstArg = init.arguments[0];
  const isNumericInitial =
    firstArg !== undefined && firstArg.type === "NumericLiteral";

  if (isNumericInitial && (directive.min === undefined || directive.max === undefined)) {
    throw new Error(
      `@runtime-inspector/babel-plugin: "${name}" is annotated with @inspect but has a numeric initial value ` +
        `without min/max. Sliders require an explicit range - write ` +
        `"// @inspect min=<number> max=<number>" instead.`
    );
  }
}

function ensureRuntimeHelperImport(
  path: NodePath,
  helperName: string,
  api: BabelAPI
): void {
  const program = path.findParent((candidate) => candidate.isProgram());
  if (!program || !program.isProgram()) return;

  const stateBag = programState(path);
  stateBag._riRuntimeHelpers ??= new Set();
  if (stateBag._riRuntimeHelpers.has(helperName)) return;

  const t = api.types;
  let existingImport: NodePath<Node> | undefined;
  for (const statementPath of program.get("body") as NodePath<Node>[]) {
    if (
      statementPath.isImportDeclaration() &&
      statementPath.node.source.value === SOURCE_MODULE
    ) {
      existingImport = statementPath;
      break;
    }
  }

  if (existingImport && existingImport.isImportDeclaration()) {
    const hasHelper = existingImport.node.specifiers.some(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === helperName
    );
    if (!hasHelper) {
      existingImport.node.specifiers.push(
        t.importSpecifier(t.identifier(helperName), t.identifier(helperName))
      );
    }
  } else {
    program.unshiftContainer(
      "body",
      t.importDeclaration(
        [t.importSpecifier(t.identifier(helperName), t.identifier(helperName))],
        t.stringLiteral(SOURCE_MODULE)
      )
    );
  }

  stateBag._riRuntimeHelpers.add(helperName);
}

function ensureHelperImport(
  path: NodePath<VariableDeclarator>,
  _state: PluginPass,
  api: BabelAPI
): void {
  const program = path.findParent((p) => p.isProgram());
  if (!program || !program.isProgram()) return;

  const alreadyImported = (
    program as unknown as { _riHelperImported?: boolean }
  )._riHelperImported;
  if (alreadyImported) return;

  const t = api.types;

  // If an import from SOURCE_MODULE already exists, add the specifier there.
  let existingImport: NodePath<Node> | undefined;
  for (const statementPath of program.get("body") as NodePath<Node>[]) {
    if (
      statementPath.isImportDeclaration() &&
      statementPath.node.source.value === SOURCE_MODULE
    ) {
      existingImport = statementPath;
      break;
    }
  }

  if (existingImport && existingImport.isImportDeclaration()) {
    const hasHelper = existingImport.node.specifiers.some(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === HELPER_NAME
    );
    if (!hasHelper) {
      existingImport.node.specifiers.push(
        t.importSpecifier(t.identifier(HELPER_NAME), t.identifier(HELPER_NAME))
      );
    }
  } else {
    const importDeclaration = t.importDeclaration(
      [t.importSpecifier(t.identifier(HELPER_NAME), t.identifier(HELPER_NAME))],
      t.stringLiteral(SOURCE_MODULE)
    );
    program.unshiftContainer("body", importDeclaration);
  }

  (program as unknown as { _riHelperImported?: boolean })._riHelperImported = true;
}