import type { NodePath } from "@babel/core";
import type * as BabelTypesNamespace from "@babel/types";
import type {
  ArrowFunctionExpression,
  AssignmentExpression,
  CallExpression,
  CommentBlock,
  CommentLine,
  Expression,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  Program,
  Statement,
  VariableDeclarator
} from "@babel/types";
import { parseSceneComment, type SceneDirective } from "./scene-directive";

export const MOTION_HELPER_NAME = "__riMotion";
export const PROBE_HELPER_NAME = "__riProbe";

/** A discovered animation assignment (the same callsite id `buildAnimationMeta` emits). */
export interface DiscoveredAnimation {
  callsiteId: string;
  /** The assigned expression without `.value` (`titleY`, `card.moveX`). */
  target: string;
  /** The root identifier of the target (`titleY`, `card`). */
  root: string;
}

export interface MotionPassOptions {
  types: typeof BabelTypesNamespace;
  /** File path relative to the Babel root, as used in callsite ids. */
  file: string;
  discover(path: NodePath<AssignmentExpression>): DiscoveredAnimation | undefined;
  ensureImport(path: NodePath, helperName: string): void;
}

type FunctionNode = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression;

interface Component {
  name: string;
  fn: NodePath<FunctionNode>;
}

interface Candidate {
  kind: "declaration" | "initializer" | "effect";
  /** Scene id suffix: the function name, or `effect@<line>`. */
  idName: string;
  /** `meta.name`: the function name, or "effect". */
  metaName: string;
  line: number;
  statementIndex: number;
  statement: NodePath<Statement>;
  fn: NodePath<FunctionNode>;
  /** The node a reference to the motion function resolves to (declaration or declarator). */
  bindingNode: Node | undefined;
  /** Initializer: the declarator's init. Effect: the effect callback. */
  wrapTarget: NodePath<Expression> | undefined;
  directive: SceneDirective | undefined;
  explicit: boolean;
  callsites: string[];
}

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);
const EXPLICIT_SCENE_HOOKS = new Set(["useScene", "useAction"]);

/**
 * RFC 0008 §1, §2, §4, §5: turns the motion functions of every module-level component
 * into `__riMotion(...)` scenes and wraps animated top-level `useSharedValue(<literal>)`
 * declarations with `__riProbe(...)`. Runs on the untouched program, before the animation
 * call sites are instrumented, so it must use the same callsite ids as the later pass.
 */
export function instrumentMotions(program: NodePath<Program>, options: MotionPassOptions): void {
  for (const component of findComponents(program)) {
    instrumentComponent(component, options);
  }
}

function instrumentComponent(component: Component, options: MotionPassOptions): void {
  const body = component.fn.get("body");
  if (!body.isBlockStatement()) return;

  const statements = body.get("body") as NodePath<Statement>[];
  const candidates = collectCandidates(statements);
  const byFunction = new Map<Node, Candidate>();
  const byBinding = new Map<Node, Candidate>();
  for (const candidate of candidates) {
    byFunction.set(candidate.fn.node, candidate);
    if (candidate.bindingNode) byBinding.set(candidate.bindingNode, candidate);
  }

  const animatedDeclarators = new Set<Node>();
  const componentFn = component.fn.node;

  component.fn.traverse({
    CallExpression(path) {
      const name = calleeName(path.node.callee);
      if (!name || !EXPLICIT_SCENE_HOOKS.has(name)) return;
      for (const argument of path.get("arguments")) {
        if (!argument.isIdentifier()) continue;
        const bindingNode = argument.scope.getBinding(argument.node.name)?.path.node;
        const candidate = bindingNode ? byBinding.get(bindingNode) : undefined;
        if (candidate) candidate.explicit = true;
      }
    },
    AssignmentExpression(path) {
      const animation = options.discover(path);
      if (!animation) return;

      // Nearest enclosing motion-function candidate; the walk stops at the component.
      let current: NodePath | null = path.parentPath;
      while (current && current.node !== componentFn) {
        if (current.isFunction()) {
          const candidate = byFunction.get(current.node);
          if (candidate) {
            candidate.callsites.push(animation.callsiteId);
            break;
          }
        }
        current = current.parentPath;
      }

      // RFC 0008 §5: a top-level shared value assigned directly by this animation.
      if (animation.target !== animation.root) return;
      const binding = path.scope.getBinding(animation.root);
      const declarator = binding?.path;
      if (
        declarator?.isVariableDeclarator() &&
        declarator.parentPath?.parentPath?.node === body.node
      ) {
        animatedDeclarators.add(declarator.node);
      }
    }
  });

  const firstReturn = firstComponentReturnIndex(statements);
  const isMotion = (candidate: Candidate) =>
    candidate.callsites.length > 0 &&
    !candidate.explicit &&
    candidate.directive?.off !== true &&
    candidate.statementIndex < firstReturn;

  const motions = candidates.filter((candidate) => candidate.kind !== "effect" && isMotion(candidate));
  const motionBindings = new Set(motions.map((candidate) => candidate.bindingNode));
  const effects = candidates.filter(
    (candidate) =>
      candidate.kind === "effect" &&
      isMotion(candidate) &&
      isPureMotionEffect(candidate.fn, motionBindings)
  );

  for (const candidate of [...motions, ...effects]) {
    injectMotion(component, candidate, options);
  }

  for (const statement of statements) {
    if (!statement.isVariableDeclaration()) continue;
    for (const declarator of statement.get("declarations")) {
      if (animatedDeclarators.has(declarator.node)) {
        injectProbe(component, declarator, options);
      }
    }
  }
}

/** Module-level function components (RFC 0008 §1): uppercase function declarations or `const` arrows/functions. */
function findComponents(program: NodePath<Program>): Component[] {
  const components: Component[] = [];
  for (const statement of program.get("body") as NodePath<Statement>[]) {
    let declaration: NodePath<Node> = statement;
    if (statement.isExportNamedDeclaration() || statement.isExportDefaultDeclaration()) {
      const inner = statement.get("declaration") as NodePath<Node | null | undefined>;
      if (!inner.node) continue;
      declaration = inner as NodePath<Node>;
    }

    if (declaration.isFunctionDeclaration()) {
      const name = declaration.node.id?.name;
      if (name && isComponentName(name)) {
        components.push({ name, fn: declaration });
      }
      continue;
    }

    if (declaration.isVariableDeclaration() && declaration.node.kind === "const") {
      for (const declarator of declaration.get("declarations")) {
        const id = declarator.node.id;
        if (id.type !== "Identifier" || !isComponentName(id.name)) continue;
        const init = declarator.get("init");
        if (init.isArrowFunctionExpression() || init.isFunctionExpression()) {
          components.push({ name: id.name, fn: init });
        }
      }
    }
  }
  return components;
}

/** Direct component-body statements that may hold a motion function (RFC 0008 §1). */
function collectCandidates(statements: NodePath<Statement>[]): Candidate[] {
  const candidates: Candidate[] = [];

  statements.forEach((statement, statementIndex) => {
    if (statement.isFunctionDeclaration()) {
      const name = statement.node.id?.name;
      // Nested component definitions are out of scope.
      if (!name || isComponentName(name)) return;
      candidates.push({
        kind: "declaration",
        idName: name,
        metaName: name,
        line: statement.node.loc?.start.line ?? 0,
        statementIndex,
        statement,
        fn: statement,
        bindingNode: statement.node,
        wrapTarget: undefined,
        directive: sceneDirective(statement),
        explicit: false,
        callsites: []
      });
      return;
    }

    if (statement.isVariableDeclaration() && statement.node.kind === "const") {
      for (const declarator of statement.get("declarations")) {
        const id = declarator.node.id;
        if (id.type !== "Identifier" || isComponentName(id.name)) continue;
        const fn = motionInitializerFunction(declarator);
        if (!fn) continue;
        candidates.push({
          kind: "initializer",
          idName: id.name,
          metaName: id.name,
          line: declarator.node.loc?.start.line ?? 0,
          statementIndex,
          statement,
          fn,
          bindingNode: declarator.node,
          wrapTarget: declarator.get("init") as NodePath<Expression>,
          directive: sceneDirective(statement),
          explicit: false,
          callsites: []
        });
      }
      return;
    }

    if (statement.isExpressionStatement()) {
      const expression = statement.get("expression");
      if (!expression.isCallExpression()) return;
      const name = calleeName(expression.node.callee);
      if (!name || !EFFECT_HOOKS.has(name)) return;
      const callback = expression.get("arguments")[0];
      if (!callback || !(callback.isArrowFunctionExpression() || callback.isFunctionExpression())) {
        return;
      }
      const line = statement.node.loc?.start.line ?? 0;
      candidates.push({
        kind: "effect",
        idName: `effect@${line}`,
        metaName: "effect",
        line,
        statementIndex,
        statement,
        fn: callback,
        bindingNode: undefined,
        wrapTarget: callback as NodePath<Expression>,
        directive: sceneDirective(statement),
        explicit: false,
        callsites: []
      });
    }
  });

  return candidates;
}

/** `<arrow | function expression>` or `useCallback(<arrow | function expression>, deps)`. */
function motionInitializerFunction(
  declarator: NodePath<VariableDeclarator>
): NodePath<FunctionNode> | undefined {
  const init = declarator.get("init");
  if (init.isArrowFunctionExpression() || init.isFunctionExpression()) return init;
  if (init.isCallExpression() && calleeName(init.node.callee) === "useCallback") {
    const callback = init.get("arguments")[0];
    if (callback && (callback.isArrowFunctionExpression() || callback.isFunctionExpression())) {
      return callback;
    }
  }
  return undefined;
}

/**
 * RFC 0008 §1.3: every statement of the effect is an assignment to a `.value` member or a
 * call to a motion function of the same component.
 */
function isPureMotionEffect(fn: NodePath<FunctionNode>, motionBindings: Set<Node | undefined>): boolean {
  const body = fn.node.body;
  const expressions: Node[] = [];
  if (body.type === "BlockStatement") {
    for (const statement of body.body) {
      if (statement.type !== "ExpressionStatement") return false;
      expressions.push(statement.expression);
    }
  } else {
    expressions.push(body);
  }

  return expressions.every((expression) => {
    if (expression.type === "AssignmentExpression") {
      return (
        expression.operator === "=" &&
        expression.left.type === "MemberExpression" &&
        !expression.left.computed &&
        expression.left.property.type === "Identifier" &&
        expression.left.property.name === "value"
      );
    }
    if (expression.type === "CallExpression" && expression.callee.type === "Identifier") {
      const bindingNode = fn.scope.getBinding(expression.callee.name)?.path.node;
      return bindingNode !== undefined && motionBindings.has(bindingNode);
    }
    return false;
  });
}

/**
 * Index of the first body statement that can return from the component. Injected hooks
 * must precede it so they stay unconditional.
 */
function firstComponentReturnIndex(statements: NodePath<Statement>[]): number {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (statement.isReturnStatement()) return index;
    let found = false;
    statement.traverse({
      Function(path) {
        path.skip();
      },
      ReturnStatement(path) {
        found = true;
        path.stop();
      }
    });
    if (found) return index;
  }
  return Number.POSITIVE_INFINITY;
}

function injectMotion(component: Component, candidate: Candidate, options: MotionPassOptions): void {
  const t = options.types;
  const sceneId = `${options.file}:${component.name}.${candidate.idName}`;
  const directive = candidate.directive?.off === false ? candidate.directive : undefined;

  const properties = [
    t.objectProperty(t.identifier("component"), t.stringLiteral(component.name)),
    t.objectProperty(t.identifier("name"), t.stringLiteral(candidate.metaName)),
    t.objectProperty(t.identifier("file"), t.stringLiteral(options.file)),
    t.objectProperty(t.identifier("line"), t.numericLiteral(candidate.line))
  ];
  if (directive?.title !== undefined) {
    properties.push(t.objectProperty(t.identifier("title"), t.stringLiteral(directive.title)));
  }
  if (directive?.group !== undefined) {
    properties.push(t.objectProperty(t.identifier("group"), t.stringLiteral(directive.group)));
  }
  properties.push(
    t.objectProperty(
      t.identifier("callsites"),
      t.arrayExpression(candidate.callsites.map((callsiteId) => t.stringLiteral(callsiteId)))
    )
  );
  const meta = t.objectExpression(properties);

  if (candidate.kind === "declaration") {
    candidate.statement.insertAfter(
      t.expressionStatement(
        t.callExpression(t.identifier(MOTION_HELPER_NAME), [
          t.stringLiteral(sceneId),
          t.identifier(candidate.idName),
          meta
        ])
      )
    );
  } else {
    const target = candidate.wrapTarget!;
    target.replaceWith(
      t.callExpression(t.identifier(MOTION_HELPER_NAME), [t.stringLiteral(sceneId), target.node, meta])
    );
  }

  options.ensureImport(candidate.statement, MOTION_HELPER_NAME);
}

function injectProbe(
  component: Component,
  declarator: NodePath<VariableDeclarator>,
  options: MotionPassOptions
): void {
  const id = declarator.node.id;
  const init = declarator.node.init;
  if (id.type !== "Identifier" || !init || !isLiteralSharedValueCall(init)) return;

  const t = options.types;
  declarator.get("init").replaceWith(
    t.callExpression(t.identifier(PROBE_HELPER_NAME), [
      init,
      t.stringLiteral(id.name),
      t.objectExpression([
        t.objectProperty(t.identifier("component"), t.stringLiteral(component.name)),
        t.objectProperty(t.identifier("file"), t.stringLiteral(options.file))
      ])
    ])
  );
  options.ensureImport(declarator, PROBE_HELPER_NAME);
}

/** `useSharedValue(<number or boolean literal>)`; a negated number literal counts as a number. */
function isLiteralSharedValueCall(node: Node): node is CallExpression {
  if (node.type !== "CallExpression" || calleeName(node.callee) !== "useSharedValue") return false;
  if (node.arguments.length !== 1) return false;
  const [argument] = node.arguments;
  if (argument.type === "NumericLiteral" || argument.type === "BooleanLiteral") return true;
  return (
    argument.type === "UnaryExpression" &&
    argument.operator === "-" &&
    argument.argument.type === "NumericLiteral"
  );
}

function sceneDirective(statement: NodePath<Statement>): SceneDirective | undefined {
  const comments = (statement.node.leadingComments ?? []) as Array<CommentLine | CommentBlock>;
  for (const comment of comments) {
    let parsed: SceneDirective | undefined;
    try {
      parsed = parseSceneComment(comment.value);
    } catch (error) {
      throw statement.buildCodeFrameError(
        `@runtime-inspector/babel-plugin: ${(error as Error).message}`
      );
    }
    if (parsed) return parsed;
  }
  return undefined;
}

function calleeName(callee: Node): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}
