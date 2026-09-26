import type { ConfigAPI, NodePath, PluginObj, PluginPass } from "@babel/core";
import type * as BabelTypesNamespace from "@babel/types";
import type {
  CallExpression,
  CommentBlock,
  CommentLine,
  Node,
  VariableDeclarator
} from "@babel/types";
import { relative, sep } from "node:path";
import { parseDirectiveComment, type ParsedDirective } from "./directive";

const HELPER_NAME = "__riInspect";
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
      Program(programPath) {
        if (isProduction) return;
        // Reset per-file import bookkeeping via plugin pass state instead of
        // module-level state (Program enter runs once per file).
        (programPath as unknown as { _riHelperImported?: boolean })._riHelperImported = false;
      },
      VariableDeclarator(path: NodePath<VariableDeclarator>, state: PluginPass) {
        if (isProduction) return;

        const init = path.node.init;
        if (!init || init.type !== "CallExpression") return;
        if (!isUseSharedValueCallee(init.callee)) return;

        const id = path.node.id;
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
        ensureHelperImport(path, state, api);
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
function collectEnclosure(path: NodePath<VariableDeclarator>): string[] {
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
