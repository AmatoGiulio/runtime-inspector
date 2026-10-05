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
import {
  instrumentMotions,
  MOTION_HELPER_NAME,
  PROBE_HELPER_NAME,
  type DiscoveredAnimation
} from "./motion";

const HELPER_NAME = "__riInspect";
const ANIMATION_OBSERVER_HELPER_NAME = "__riObserveAnimation";
const ANIMATION_CONFIG_HELPER_NAME = "__riAnimationConfig";
const ANIMATION_DELAY_HELPER_NAME = "__riAnimationDelay";
const ANIMATION_START_HELPER_NAME = "__riAnimationStart";
const MODULE_CALLSITES_HELPER_NAME = "__riModuleCallsites";
const WITH_DELAY_LOCAL_NAME = "__riWithDelay";
const AUTO_SCHEMA_ID = "auto";
const START_DELAY_MIN_MS = 0;
const START_DELAY_MAX_MS = 10000;
const SOURCE_MODULE = "@runtime-inspector/react-native";
const REANIMATED_MODULE = "react-native-reanimated";

type AnimationKind = "timing" | "spring";

/** A config key whose numeric literal is backed by a slider control (RFC 0005 §3b/§3c). */
interface LiteralParameterSpec {
  key: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

const LITERAL_PARAMETER_SPECS: Record<AnimationKind, readonly LiteralParameterSpec[]> = {
  timing: [{ key: "duration", min: 0, max: 10000, step: 1, unit: "ms" }],
  spring: [
    { key: "damping", min: 0, max: 100, step: 0.1 },
    { key: "stiffness", min: 1, max: 1000, step: 1 },
    { key: "mass", min: 0.1, max: 10, step: 0.1 }
  ]
};

interface LiteralParameterBinding {
  spec: LiteralParameterSpec;
  declared: number;
  /** Source text of the literal as written, or undefined when its range is unknown. */
  init: string | undefined;
}

/**
 * The assignment-level part of an RFC 0007 literal anchor, shared by every
 * literal of one discovered assignment. Line/column/enclosure are the same
 * values as the meta's `source`.
 */
interface LiteralAnchorBase {
  file: string;
  line: number;
  column: number;
  enclosure: string[];
  /** Source text of the assignment's left-hand side, e.g. "titleY.value". */
  target: string;
  callee: "withTiming" | "withSpring";
}

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
      Program: {
        enter(programPath, state) {
          if (isProduction) return;
          const stateBag = programPath as unknown as ProgramStateBag;
          stateBag._riHelperImported = false;
          stateBag._riWithDelayImported = false;
          stateBag._riRuntimeHelpers = new Set();
          stateBag._riInspectorSchemas = new Map();
          stateBag._riAutoValueNames = new Set();
          stateBag._riCallsiteIds = new Set();
          stateBag._riReanimatedModule = programHasReanimatedImport(programPath.node);
          stateBag._riSkipAnimationInstrumentation = shouldSkipAnimationInstrumentation(
            state.filename ?? state.file.opts.filename ?? undefined
          );

          // RFC 0008: automatic motions and probes, decided on the untouched program so the
          // callsite ids match the ones the AssignmentExpression visitor emits afterwards.
          const file = relativeSourceFile(state);
          if (!stateBag._riSkipAnimationInstrumentation && file) {
            instrumentMotions(programPath, {
              types: api.types,
              file,
              discover: (path) => discoverAnimation(path, state)?.discovered,
              ensureImport: (path, helperName) => ensureRuntimeHelperImport(path, helperName, api)
            });
          }
        },
        // Fast Refresh: tell the runtime which call sites this module still has, so
        // the `auto` controls of call sites that moved or disappeared are disposed.
        exit(programPath, state) {
          if (isProduction) return;
          const stateBag = programPath as unknown as ProgramStateBag;
          if (stateBag._riSkipAnimationInstrumentation) return;
          if (!stateBag._riReanimatedModule) return;
          // Dependencies are not edited under Fast Refresh, so they cannot orphan controls;
          // skipping them keeps the runtime import out of every library using Reanimated.
          if (isDependencyFile(state.filename ?? state.file.opts.filename ?? undefined)) return;
          const file = relativeSourceFile(state);
          if (!file) return;
          injectModuleCallsites(programPath, file, [...(stateBag._riCallsiteIds ?? [])], api);
        }
      },
      VariableDeclarator(path: NodePath<VariableDeclarator>, state: PluginPass) {
        if (isProduction) return;

        // RFC 0008 §5: an automatic probe wraps the declaration first; `// @inspect`
        // composes inside it: __riProbe(__riInspect(useSharedValue(...), ...), ...).
        const probed = isProbeHelperCall(path.node.init);
        const init = probed
          ? ((path.node.init as CallExpression).arguments[0] as Node)
          : path.node.init;
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

        const initPath = probed
          ? (path.get("init.arguments.0") as NodePath<Node>)
          : path.get("init");
        initPath.replaceWith(call);
        programState(path)._riAutoValueNames?.add(name);
        ensureHelperImport(path, state, api);
      },
      AssignmentExpression(path: NodePath<AssignmentExpression>, state: PluginPass) {
        if (isProduction) return;
        if (programState(path)._riSkipAnimationInstrumentation) return;

        const found = discoverAnimation(path, state);
        if (!found) return;
        const { target, shape } = found;
        const right = path.node.right as CallExpression;

        const t = api.types;
        const { animationKind, delayed } = shape;
        const built = buildAnimationMeta(
          path,
          state,
          target,
          animationKind,
          innerAnimationCall(right, delayed),
          api
        );
        if (!built) return;
        const { meta, callsiteId, literalBase } = built;
        programState(path)._riCallsiteIds?.add(callsiteId);

        // Preserve the application's original Reanimated call exactly. Runtime
        // Inspector observes the animation object *after* Reanimated constructs it
        // and returns that same object unchanged.
        const transformed = t.cloneNode(right, true);
        const animationCall = innerAnimationCall(transformed, delayed);

        // RFC 0005 §3b/§3c: each eligible literal parameter is backed by an ordinary
        // slider control. Only the config argument is wrapped; the application still
        // makes its own `withTiming` / `withSpring` call.
        // Bindings come from the original call so each literal's source text is known.
        const bindings = literalParameterBindings(
          animationKind,
          innerAnimationCall(right, delayed).arguments[1],
          state.file.code
        );
        if (bindings.length > 0) {
          animationCall.arguments[1] = t.callExpression(
            t.identifier(ANIMATION_CONFIG_HELPER_NAME),
            [
              animationCall.arguments[1],
              t.arrayExpression(
                bindings.map((binding) =>
                  parameterBindingExpression(t, callsiteId, target.target, binding, literalBase)
                )
              )
            ]
          );
          meta.properties.push(parameterControlsProperty(t, callsiteId, bindings));
        }

        // RFC 0005 §3c: the start is movable through a delay control. A delayed
        // call gets its delay argument wrapped; a bare call is wrapped whole, and
        // only when the module already imports Reanimated.
        let observed: BabelTypesNamespace.Expression = transformed;
        let startHelperName: string | undefined;
        if (delayed) {
          const declaredDelay = eligibleDelayLiteral(transformed.arguments[0]);
          const delayInit = sourceText(right.arguments[0], state.file.code);
          transformed.arguments[0] = t.callExpression(t.identifier(ANIMATION_DELAY_HELPER_NAME), [
            transformed.arguments[0],
            startBindingExpression(
              t,
              callsiteId,
              target.target,
              declaredDelay,
              literalBase && delayInit !== undefined
                ? { ...literalBase, parameter: "delay", init: delayInit }
                : undefined
            )
          ]);
          if (declaredDelay !== undefined) {
            meta.properties.push(startControlProperty(t, callsiteId));
          }
          startHelperName = ANIMATION_DELAY_HELPER_NAME;
        } else if (hasReanimatedImport(path)) {
          observed = t.callExpression(t.identifier(ANIMATION_START_HELPER_NAME), [
            transformed,
            startBindingExpression(
              t,
              callsiteId,
              target.target,
              0,
              literalBase && { ...literalBase, parameter: "delay", init: null }
            ),
            t.identifier(WITH_DELAY_LOCAL_NAME)
          ]);
          meta.properties.push(startControlProperty(t, callsiteId));
          startHelperName = ANIMATION_START_HELPER_NAME;
          ensureWithDelayImport(path, api);
        }

        path.get("right").replaceWith(
          t.callExpression(t.identifier(ANIMATION_OBSERVER_HELPER_NAME), [observed, meta])
        );
        ensureRuntimeHelperImport(path, ANIMATION_OBSERVER_HELPER_NAME, api);
        if (bindings.length > 0) {
          ensureRuntimeHelperImport(path, ANIMATION_CONFIG_HELPER_NAME, api);
        }
        if (startHelperName) {
          ensureRuntimeHelperImport(path, startHelperName, api);
        }
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

/** A `__riProbe(<init>, ...)` call injected by the RFC 0008 motion pass. */
function isProbeHelperCall(node: Node | null | undefined): node is CallExpression {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === PROBE_HELPER_NAME &&
    node.arguments[0]?.type === "CallExpression"
  );
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

/** The called name of an `Identifier` or non-computed member callee. */
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

function animationKindForCallee(callee: Node): AnimationKind | undefined {
  const name = calleeName(callee);
  if (name === "withTiming") return "timing";
  if (name === "withSpring") return "spring";
  return undefined;
}

/** The kind of a direct `withTiming` / `withSpring` call that passes the argument guards. */
function eligibleAnimationKind(call: CallExpression): AnimationKind | undefined {
  const animationKind = animationKindForCallee(call.callee);
  if (!animationKind) return undefined;

  // First spike: preserve any user completion callback untouched. Reanimated's
  // Babel plugin owns callback workletization, so calls with a third argument
  // are deliberately left alone until callback composition is proven safe.
  if (call.arguments.length > 2 || call.arguments.length === 0) return undefined;
  if (call.arguments.some((argument) => argument.type === "SpreadElement")) return undefined;

  return animationKind;
}

/**
 * RFC 0005 §3c: the two discovered right-hand sides. Bare is a direct animation
 * call; delayed is `withDelay(<delay>, <animation call>)` with exactly two
 * arguments. Anything else returns `undefined` and is left untouched.
 */
function animationAssignmentShape(
  right: CallExpression
): { animationKind: AnimationKind; delayed: boolean } | undefined {
  const bareKind = eligibleAnimationKind(right);
  if (bareKind) return { animationKind: bareKind, delayed: false };

  if (calleeName(right.callee) !== "withDelay") return undefined;
  if (right.arguments.length !== 2) return undefined;
  if (right.arguments.some((argument) => argument.type === "SpreadElement")) return undefined;

  const inner = right.arguments[1];
  if (inner.type !== "CallExpression") return undefined;

  const delayedKind = eligibleAnimationKind(inner);
  return delayedKind ? { animationKind: delayedKind, delayed: true } : undefined;
}

/** The `withTiming` / `withSpring` call of a shape accepted by `animationAssignmentShape`. */
function innerAnimationCall(right: CallExpression, delayed: boolean): CallExpression {
  return delayed ? (right.arguments[1] as CallExpression) : right;
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

/**
 * The eligibility rules of the AssignmentExpression visitor: a `<target>.value = <animation>`
 * assignment of an accepted shape, outside known worklet contexts, with a callsite id.
 * Shared with the RFC 0008 motion pass so both use the same ids.
 */
function discoverAnimation(
  path: NodePath<AssignmentExpression>,
  state: PluginPass
):
  | {
      target: { target: string; root: string };
      shape: { animationKind: AnimationKind; delayed: boolean };
      discovered: DiscoveredAnimation;
    }
  | undefined {
  if (path.node.operator !== "=") return undefined;

  const target = animationAssignmentTarget(path.node.left, state);
  if (!target) return undefined;

  const right = path.node.right;
  if (right.type !== "CallExpression") return undefined;

  const shape = animationAssignmentShape(right);
  if (!shape) return undefined;

  if (isInsideKnownWorkletContext(path)) return undefined;

  const site = animationCallsite(path, state, target, shape.animationKind);
  if (!site) return undefined;

  return {
    target,
    shape,
    discovered: { callsiteId: site.callsiteId, target: target.target, root: target.root }
  };
}

/** The file path relative to the Babel root (or cwd), or undefined when either is unknown. */
function relativeSourceFile(state: PluginPass): string | undefined {
  const filename = state.filename ?? state.file.opts.filename ?? undefined;
  const rootDir = state.file.opts.root ?? state.file.opts.cwd ?? undefined;
  if (!filename || !rootDir) return undefined;
  return relative(rootDir, filename).split(sep).join("/");
}

function animationCallsite(
  path: NodePath<AssignmentExpression>,
  state: PluginPass,
  target: { target: string; root: string },
  animationKind: AnimationKind
) {
  const file = relativeSourceFile(state);
  const loc = path.node.loc;
  if (!file || !loc) return undefined;
  const callsiteId = `${file}:${loc.start.line}:${loc.start.column}:${animationKind}:${target.target}`;
  return { file, loc, callsiteId };
}

function buildAnimationMeta(
  path: NodePath<AssignmentExpression>,
  state: PluginPass,
  target: { target: string; root: string },
  animationKind: AnimationKind,
  animationCall: CallExpression,
  api: BabelAPI
) {
  const site = animationCallsite(path, state, target, animationKind);
  if (!site) return undefined;
  const { file, loc, callsiteId } = site;
  const stateBag = programState(path);
  const schemaId =
    stateBag._riInspectorSchemas?.get(target.root) ??
    (stateBag._riAutoValueNames?.has(target.root) ? "auto" : undefined);

  const expression =
    path.node.right.start != null && path.node.right.end != null
      ? state.file.code.slice(path.node.right.start, path.node.right.end)
      : "";

  const t = api.types;
  const enclosure = collectEnclosure(path);
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
          t.arrayExpression(enclosure.map((entry) => t.stringLiteral(entry)))
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

  const left = path.node.left;
  const literalBase: LiteralAnchorBase | undefined =
    left.start != null && left.end != null
      ? {
          file,
          line: loc.start.line,
          column: loc.start.column,
          enclosure,
          target: state.file.code.slice(left.start, left.end),
          callee: animationKind === "timing" ? "withTiming" : "withSpring"
        }
      : undefined;

  return { meta: t.objectExpression(properties), callsiteId, literalBase };
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

/**
 * RFC 0005 §3b/§3c eligibility. `config` must be an object literal with no
 * spread. A key is bound only when the object has exactly one member with that
 * key, written as a plain property whose value is a finite numeric literal
 * within the key's slider range. Keys that do not qualify are simply not bound.
 */
function literalParameterBindings(
  animationKind: AnimationKind,
  config: Node | null | undefined,
  code: string
): LiteralParameterBinding[] {
  if (!config || config.type !== "ObjectExpression") return [];
  if (config.properties.some((property) => property.type === "SpreadElement")) return [];

  const bindings: LiteralParameterBinding[] = [];
  for (const spec of LITERAL_PARAMETER_SPECS[animationKind]) {
    const members = config.properties.filter((member) => isMemberKeyed(member, spec.key));
    if (members.length !== 1) continue;

    const [member] = members;
    if (member.type !== "ObjectProperty" || member.computed) continue;
    if (member.value.type !== "NumericLiteral") continue;

    const declared = member.value.value;
    if (!Number.isFinite(declared)) continue;
    if (declared < spec.min || declared > spec.max) continue;
    bindings.push({ spec, declared, init: sourceText(member.value, code) });
  }
  return bindings;
}

/** The original source text of `node`, or undefined when its range is unknown. */
function sourceText(node: Node | null | undefined, code: string): string | undefined {
  if (!node || node.start == null || node.end == null) return undefined;
  return code.slice(node.start, node.end);
}

/** RFC 0007: the `literal` anchor property of a binding descriptor. */
function literalAnchorProperty(
  t: BabelAPI["types"],
  anchor: LiteralAnchorBase & { parameter: string; init: string | null }
) {
  return t.objectProperty(
    t.identifier("literal"),
    t.objectExpression([
      t.objectProperty(t.identifier("file"), t.stringLiteral(anchor.file)),
      t.objectProperty(t.identifier("line"), t.numericLiteral(anchor.line)),
      t.objectProperty(t.identifier("column"), t.numericLiteral(anchor.column)),
      t.objectProperty(
        t.identifier("enclosure"),
        t.arrayExpression(anchor.enclosure.map((entry) => t.stringLiteral(entry)))
      ),
      t.objectProperty(t.identifier("target"), t.stringLiteral(anchor.target)),
      t.objectProperty(t.identifier("callee"), t.stringLiteral(anchor.callee)),
      t.objectProperty(t.identifier("parameter"), t.stringLiteral(anchor.parameter)),
      t.objectProperty(
        t.identifier("init"),
        anchor.init === null ? t.nullLiteral() : t.stringLiteral(anchor.init)
      )
    ])
  );
}

function isMemberKeyed(
  member: BabelTypesNamespace.ObjectExpression["properties"][number],
  key: string
): member is BabelTypesNamespace.ObjectProperty | BabelTypesNamespace.ObjectMethod {
  if (member.type === "SpreadElement") return false;
  if (member.key.type === "StringLiteral") return member.key.value === key;
  return !member.computed && member.key.type === "Identifier" && member.key.name === key;
}

/** The `__riAnimationConfig` binding descriptor for one literal parameter. */
function parameterBindingExpression(
  t: BabelAPI["types"],
  callsiteId: string,
  target: string,
  { spec, declared, init }: LiteralParameterBinding,
  literalBase: LiteralAnchorBase | undefined
) {
  const properties = [
    t.objectProperty(t.identifier("key"), t.stringLiteral(spec.key)),
    t.objectProperty(t.identifier("controlId"), t.stringLiteral(`${callsiteId}:${spec.key}`)),
    t.objectProperty(t.identifier("label"), t.stringLiteral(`${target} ${spec.key}`)),
    t.objectProperty(t.identifier("declared"), t.numericLiteral(declared)),
    t.objectProperty(t.identifier("min"), t.numericLiteral(spec.min)),
    t.objectProperty(t.identifier("max"), t.numericLiteral(spec.max)),
    t.objectProperty(t.identifier("step"), t.numericLiteral(spec.step))
  ];
  if (spec.unit !== undefined) {
    properties.push(t.objectProperty(t.identifier("unit"), t.stringLiteral(spec.unit)));
  }
  if (literalBase && init !== undefined) {
    properties.push(literalAnchorProperty(t, { ...literalBase, parameter: spec.key, init }));
  }
  return t.objectExpression(properties);
}

/** A `{ schemaId: "auto", controlId }` reference to a control in the `auto` schema. */
function autoControlReference(t: BabelAPI["types"], controlId: string) {
  return t.objectExpression([
    t.objectProperty(t.identifier("schemaId"), t.stringLiteral(AUTO_SCHEMA_ID)),
    t.objectProperty(t.identifier("controlId"), t.stringLiteral(controlId))
  ]);
}

/** The `parameterControls` meta entry pointing at each bound key's `auto` control. */
function parameterControlsProperty(
  t: BabelAPI["types"],
  callsiteId: string,
  bindings: readonly LiteralParameterBinding[]
) {
  return t.objectProperty(
    t.identifier("parameterControls"),
    t.objectExpression(
      bindings.map(({ spec }) =>
        t.objectProperty(
          t.identifier(spec.key),
          autoControlReference(t, `${callsiteId}:${spec.key}`)
        )
      )
    )
  );
}

/** RFC 0005 §3c: the declared delay when `node` is a finite numeric literal in range. */
function eligibleDelayLiteral(node: Node | null | undefined): number | undefined {
  if (!node || node.type !== "NumericLiteral") return undefined;
  const declared = node.value;
  if (!Number.isFinite(declared)) return undefined;
  if (declared < START_DELAY_MIN_MS || declared > START_DELAY_MAX_MS) return undefined;
  return declared;
}

/**
 * The binding passed to `__riAnimationDelay` / `__riAnimationStart`. Without a
 * `declared` delay it carries only the call site, so the applied delay can be
 * observed but no control is created.
 */
function startBindingExpression(
  t: BabelAPI["types"],
  callsiteId: string,
  target: string,
  declared: number | undefined,
  literal: (LiteralAnchorBase & { parameter: "delay"; init: string | null }) | undefined
) {
  const properties = [t.objectProperty(t.identifier("callsiteId"), t.stringLiteral(callsiteId))];
  if (declared !== undefined) {
    properties.push(
      t.objectProperty(t.identifier("controlId"), t.stringLiteral(`${callsiteId}:delay`)),
      t.objectProperty(t.identifier("label"), t.stringLiteral(`${target} delay`)),
      t.objectProperty(t.identifier("declared"), t.numericLiteral(declared)),
      t.objectProperty(t.identifier("min"), t.numericLiteral(START_DELAY_MIN_MS)),
      t.objectProperty(t.identifier("max"), t.numericLiteral(START_DELAY_MAX_MS)),
      t.objectProperty(t.identifier("step"), t.numericLiteral(1)),
      t.objectProperty(t.identifier("unit"), t.stringLiteral("ms"))
    );
    if (literal) {
      properties.push(literalAnchorProperty(t, literal));
    }
  }
  return t.objectExpression(properties);
}

/** The `startControl` meta entry pointing at the call site's delay control. */
function startControlProperty(t: BabelAPI["types"], callsiteId: string) {
  return t.objectProperty(
    t.identifier("startControl"),
    autoControlReference(t, `${callsiteId}:delay`)
  );
}

/** Whether the module has a non type-only import from `react-native-reanimated`. */
function hasReanimatedImport(path: NodePath): boolean {
  const program = path.findParent((candidate) => candidate.isProgram());
  if (!program || !program.isProgram()) return false;
  return programHasReanimatedImport(program.node);
}

function programHasReanimatedImport(program: BabelTypesNamespace.Program): boolean {
  return program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.source.value === REANIMATED_MODULE &&
      statement.importKind !== "type" &&
      statement.importKind !== "typeof"
  );
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

/** Per-file plugin state, stored on the Program path. */
interface ProgramStateBag {
  _riHelperImported?: boolean;
  _riRuntimeHelpers?: Set<string>;
  _riInspectorSchemas?: Map<string, string>;
  _riAutoValueNames?: Set<string>;
  _riSkipAnimationInstrumentation?: boolean;
  _riWithDelayImported?: boolean;
  /** Callsite ids of every animation assignment instrumented in this file. */
  _riCallsiteIds?: Set<string>;
  /** Whether the untouched module has a value import from Reanimated. */
  _riReanimatedModule?: boolean;
}

/** The Program path of `path`, or `path` itself when it is the Program. */
function programPathOf(path: NodePath): NodePath<BabelTypesNamespace.Program> | undefined {
  if (path.isProgram()) return path;
  const program = path.findParent((candidate) => candidate.isProgram());
  return program?.isProgram() ? program : undefined;
}

function programState(path: NodePath): ProgramStateBag {
  const program = programPathOf(path);
  if (!program) {
    throw new Error("@runtime-inspector/babel-plugin: could not resolve Program path.");
  }
  return program as unknown as ProgramStateBag;
}

/**
 * Inserts `__riModuleCallsites("<file>", [...ids])` right after the module's
 * imports, so every (re-)evaluation reports the call sites the file still has.
 */
function injectModuleCallsites(
  programPath: NodePath<BabelTypesNamespace.Program>,
  file: string,
  callsiteIds: readonly string[],
  api: BabelAPI
): void {
  const t = api.types;
  ensureRuntimeHelperImport(programPath, MODULE_CALLSITES_HELPER_NAME, api);

  const statement = t.expressionStatement(
    t.callExpression(t.identifier(MODULE_CALLSITES_HELPER_NAME), [
      t.stringLiteral(file),
      t.arrayExpression(callsiteIds.map((id) => t.stringLiteral(id)))
    ])
  );

  let lastImport: NodePath | undefined;
  for (const statementPath of programPath.get("body")) {
    if (statementPath.isImportDeclaration()) lastImport = statementPath;
  }
  if (lastImport) {
    lastImport.insertAfter(statement);
  } else {
    programPath.unshiftContainer("body", statement);
  }
}

function shouldSkipAnimationInstrumentation(filename: string | undefined): boolean {
  if (!filename) return false;
  const normalized = filename.split(sep).join("/");
  return (
    normalized.includes("/packages/runtime-react-native/") ||
    normalized.includes("/node_modules/@runtime-inspector/react-native/")
  );
}

function isDependencyFile(filename: string | undefined): boolean {
  if (!filename) return false;
  return filename.split(sep).join("/").includes("/node_modules/");
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
      let parent = current.parentPath;
      // RFC 0008: `const play = __riMotion(id, () => {...}, meta)` still encloses as "play".
      if (
        parent?.isCallExpression() &&
        parent.node.callee.type === "Identifier" &&
        parent.node.callee.name === MOTION_HELPER_NAME
      ) {
        parent = parent.parentPath;
      }
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
  const program = programPathOf(path);
  if (!program) return;

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

/**
 * Adds, once per file, a separate `import { withDelay as __riWithDelay }` from
 * Reanimated so `__riAnimationStart` can delay a bare animation without the
 * runtime package importing Reanimated itself.
 */
function ensureWithDelayImport(path: NodePath, api: BabelAPI): void {
  const program = path.findParent((candidate) => candidate.isProgram());
  if (!program || !program.isProgram()) return;

  const stateBag = programState(path);
  if (stateBag._riWithDelayImported) return;

  const t = api.types;
  program.unshiftContainer(
    "body",
    t.importDeclaration(
      [t.importSpecifier(t.identifier(WITH_DELAY_LOCAL_NAME), t.identifier("withDelay"))],
      t.stringLiteral(REANIMATED_MODULE)
    )
  );
  stateBag._riWithDelayImported = true;
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