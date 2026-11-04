import { SCENES_SCHEMA_ID } from "@runtime-inspector/protocol";
import { setRuntimeAnimationEmitter } from "./animation-observer";
import { sendRuntimeAnimationMessage, sendRuntimeMessage } from "./core";
import { setSceneStatusEmitter } from "./scenes";

// The public entry. The core lives in `./core`; scenes and the animation observer import
// the core, so their emitters are wired here rather than from the core (no import cycle).
setRuntimeAnimationEmitter(sendRuntimeAnimationMessage);
setSceneStatusEmitter((message) => sendRuntimeMessage(SCENES_SCHEMA_ID, message));

export {
  __resolveDevServerScriptUrl,
  slider,
  toggle,
  color,
  bezier,
  spring,
  trigger,
  group,
  definePanel,
  updatePanelSchema,
  bindSharedValue,
  bindValue,
  bindTrigger,
  applyControlTrigger,
  applyControlPatch,
  applyControlCommit,
  applyBatchPatch,
  attachRuntimeInspectorProtocolClient
} from "./core";
export type {
  RuntimeInspectorOptions,
  SharedValueLike,
  RuntimeInspectorProtocolSink,
  RuntimeInspectorProtocolClient
} from "./core";
export type { CubicBezier, PanelSchema, SpringValue } from "@runtime-inspector/protocol";

export { useInspector, buildInspector, deriveLabel, inferKindFromValue } from "./use-inspector";
export type {
  InspectorSpec,
  InspectorSpecEntry,
  InspectorHandles,
  SliderSpecEntry,
  SpringSpecEntry,
  InferredKind
} from "./use-inspector";

export { __riInspect } from "./auto";
export type { InspectMeta } from "./auto";

export { defineScene, defineScenes, configureScenes, useScene } from "./scenes";
export type { SceneDeclaration, UseSceneOptions, ConfigureScenesOptions } from "./scenes";
export { __riMotion, __riMotionFn, useRiScene } from "./motion";
export type { MotionMeta } from "./motion";
export { __riProbe, __riProbeValue, useRiProbe } from "./probe-auto";
export type { AutoProbeMeta } from "./probe-auto";

export { __riObserveAnimation } from "./animation-observer";
export {
  __riAnimationConfig,
  __riAnimationDelay,
  __riAnimationStart,
  __riModuleCallsites
} from "./animation-config";
export type {
  RuntimeAnimationConfigBinding,
  RuntimeAnimationStartBinding,
  RuntimeAnimationStartWrapBinding
} from "./animation-config";

export { useRuntimeValue, useAction } from "./use-runtime-value";
export type { RuntimeValueOptions, RuntimeValueRangeOptions } from "./use-runtime-value";

export { useRuntimeProbe } from "./use-runtime-probe";
export type { RuntimeProbeOptions } from "./use-runtime-probe";
export { registerRuntimeProbe } from "./recording";
export type { RuntimeProbeSource } from "./recording";
