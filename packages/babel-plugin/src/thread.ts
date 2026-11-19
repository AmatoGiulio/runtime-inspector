import type { NodePath } from "@babel/core";
import type { Node } from "@babel/types";

/**
 * Which thread a discovered animation write runs on, decided with the rules the
 * `react-native-worklets` Babel plugin uses to workletize functions (its
 * `autoworkletization`, `gestureHandlerAutoworkletization` and `referencedWorklets`
 * modules, react-native-worklets 0.13), plus Reanimated 3's `useAnimatedGestureHandler`. A function is a worklet, and runs on the UI
 * thread, when it has a `"worklet"` directive, sits in a file with one, or is passed, inline
 * or by a same-file reference, where that plugin workletizes it. Everything else is plain
 * JavaScript and can only run on the JS thread: a non-worklet cannot be called from a
 * worklet.
 *
 * The runtime helpers (`__riAnimationConfig` & co.) are JS-only, so a write is instrumented
 * only when no function around it is a worklet. Positions that may be workletized but are
 * not on the plugin's lists (any `.onX` gesture builder method, whatever its receiver, and a
 * layout animation's `.withCallback`) count as worklets too: a missed animation is better
 * than JS-only code on the UI thread.
 */

/** Call name -> indices of the arguments the worklets plugin workletizes. */
const WORKLETIZED_ARGUMENTS = new Map<string, readonly number[]>([
  ["useFrameCallback", [0]],
  ["useAnimatedStyle", [0]],
  ["useAnimatedProps", [0]],
  ["createAnimatedPropAdapter", [0]],
  ["useDerivedValue", [0]],
  ["useAnimatedScrollHandler", [0]],
  ["useAnimatedReaction", [0, 1]],
  ["useAnimatedGestureHandler", [0]],
  ["withTiming", [2, 3]],
  ["withSpring", [2, 3]],
  ["withDecay", [1]],
  ["withRepeat", [3]],
  ["runOnUI", [0]],
  ["executeOnUIRuntimeSync", [0]],
  ["scheduleOnUI", [0]],
  ["runOnUISync", [0]],
  ["runOnUIAsync", [0]],
  ["runOnRuntime", [1]],
  ["runOnRuntimeSync", [1]],
  ["runOnRuntimeAsync", [1]],
  ["scheduleOnRuntime", [1]],
  ["runOnRuntimeSyncWithId", [1]],
  ["scheduleOnRuntimeWithId", [1]]
]);

/** Hooks whose object argument's function properties are workletized. */
const OBJECT_HOOKS = new Set([
  "useAnimatedScrollHandler",
  "useAnimatedGestureHandler",
  // Gesture Handler 3 hook API.
  "useTapGesture",
  "usePanGesture",
  "usePinchGesture",
  "useRotationGesture",
  "useFlingGesture",
  "useLongPressGesture",
  "useNativeGesture",
  "useManualGesture",
  "useHoverGesture"
]);

/** Gesture Handler builder callbacks (`Gesture.Pan().onEnd(...)`). Matched on any receiver. */
const GESTURE_BUILDER_METHODS = new Set([
  "onBegin",
  "onStart",
  "onEnd",
  "onFinalize",
  "onUpdate",
  "onChange",
  "onTouchesDown",
  "onTouchesMove",
  "onTouchesUp",
  "onTouchesCancelled"
]);

/** Member calls whose arguments may be workletized although they are on no list above. */
const MAYBE_WORKLETIZED_METHODS = new Set(["withCallback"]);

/** Whether the write at `path` runs on the JS thread: no enclosing function is a worklet. */
export function runsOnJsThread(path: NodePath): boolean {
  if (fileIsWorklet(path)) return false;
  for (let fn = path.getFunctionParent(); fn; fn = fn.parentPath?.getFunctionParent() ?? null) {
    if (isWorklet(fn)) return false;
  }
  return true;
}

function fileIsWorklet(path: NodePath): boolean {
  const program = path.findParent((candidate) => candidate.isProgram());
  if (!program?.isProgram()) return false;
  return (program.node.directives ?? []).some((directive) => directive.value.value === "worklet");
}

function isWorklet(fn: NodePath): boolean {
  const body = fn.isFunction() ? fn.node.body : undefined;
  if (
    body?.type === "BlockStatement" &&
    (body.directives ?? []).some((directive) => directive.value.value === "worklet")
  ) {
    return true;
  }
  if (isWorkletizedPosition(fn)) return true;
  return referencesOf(fn).some(isWorkletizedPosition);
}

/**
 * Whether the expression at `path` (an inline function or a reference to one) is in a
 * position the worklets plugin workletizes: an argument of a workletizing call, or a property
 * of an object passed to an object hook.
 */
function isWorkletizedPosition(path: NodePath): boolean {
  const parent = path.parentPath;
  if (!parent) return false;

  if (path.isObjectMethod() && parent.isObjectExpression()) {
    return isObjectHookArgument(parent);
  }
  if (parent.isObjectProperty() && path.key === "value") {
    const object = parent.parentPath;
    return Boolean(object?.isObjectExpression() && isObjectHookArgument(object));
  }

  if (!parent.isCallExpression() || path.listKey !== "arguments") return false;
  const index = path.key as number;
  const callee = unwrapSequence(parent.node.callee);
  const name = calleeName(callee);
  if (!name) return false;

  if (WORKLETIZED_ARGUMENTS.get(name)?.includes(index)) return true;
  if (OBJECT_HOOKS.has(name)) return true;
  if (callee.type === "MemberExpression") {
    if (GESTURE_BUILDER_METHODS.has(name) || MAYBE_WORKLETIZED_METHODS.has(name)) return true;
  }
  return false;
}

/** Whether `object` is passed, inline or through a same-file `const`, to an object hook. */
function isObjectHookArgument(object: NodePath): boolean {
  const isHookArgument = (candidate: NodePath) => {
    const call = candidate.parentPath;
    if (!call?.isCallExpression() || candidate.listKey !== "arguments") return false;
    const name = calleeName(unwrapSequence(call.node.callee));
    return name !== undefined && OBJECT_HOOKS.has(name);
  };
  if (isHookArgument(object)) return true;
  return referencesOf(object).some(isHookArgument);
}

/**
 * References to the binding `path` is the value of: `function f() {}`, `const f = () => {}`,
 * `const handlers = { ... }`, or an assignment `f = () => {}`. Aliases (`const g = f`, then
 * `useAnimatedStyle(g)`) are followed, as the worklets plugin's `referencedWorklets` does.
 * Empty for anything else.
 */
function referencesOf(path: NodePath): NodePath[] {
  let id: Node | null | undefined;
  if (path.isFunctionDeclaration()) {
    id = path.node.id;
  } else if (path.parentPath?.isVariableDeclarator() && path.key === "init") {
    id = path.parentPath.node.id;
  } else if (path.parentPath?.isAssignmentExpression() && path.key === "right") {
    id = path.parentPath.node.left;
  }
  if (!id || id.type !== "Identifier") return [];
  const scope = path.isFunctionDeclaration() ? path.parentPath?.scope : path.scope;
  return withAliases(scope?.getBinding(id.name)?.referencePaths ?? [], new Set());
}

function withAliases(references: NodePath[], seen: Set<Node>): NodePath[] {
  const all: NodePath[] = [];
  for (const reference of references) {
    if (seen.has(reference.node)) continue;
    seen.add(reference.node);
    all.push(reference);
    const parent = reference.parentPath;
    let alias: Node | undefined;
    if (parent?.isVariableDeclarator() && reference.key === "init") alias = parent.node.id;
    if (parent?.isAssignmentExpression() && reference.key === "right") alias = parent.node.left;
    if (alias?.type === "Identifier") {
      const binding = reference.scope.getBinding(alias.name);
      all.push(...withAliases(binding?.referencePaths ?? [], seen));
    }
  }
  return all;
}

function unwrapSequence(callee: Node): Node {
  if (callee.type === "SequenceExpression") {
    return callee.expressions[callee.expressions.length - 1];
  }
  return callee;
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
