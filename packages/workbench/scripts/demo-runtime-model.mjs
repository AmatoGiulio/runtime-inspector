// Pure fixture model for the development-only demo runtime. No I/O.
//
// It imitates examples/react-native-reanimated/src/ProductRevealDemo.tsx: the eight
// withTiming / withSpring call sites of `play()`, each with a tunable delay and parameters.

export const AUTO_SCHEMA_ID = "auto";
export const REPLAY_CONTROL_ID = "replay";

const FILE = "demo/ProductRevealDemo.tsx";
const FIRST_LINE = 33;
const COLUMN = 4;
const ENCLOSURE = ["ProductRevealDemo", "play"];
const STAGGER_MS = 0.4;

// One entry per call site of `play()`, in source order (consecutive lines).
const SITES = [
  { target: "coverOpacity", kind: "timing", toValue: 1, delay: 0, duration: 320, expression: "withTiming(1, { duration: 320 })" },
  { target: "coverScale", kind: "spring", toValue: 1, delay: 0, damping: 14, stiffness: 160, expression: "withSpring(1, { damping: 14, stiffness: 160 })" },
  { target: "titleOpacity", kind: "timing", toValue: 1, delay: 140, duration: 300, expression: "withDelay(140, withTiming(1, { duration: 300 }))" },
  { target: "titleY", kind: "timing", toValue: 0, delay: 140, duration: 380, expression: "withDelay(140, withTiming(0, { duration: 380 }))" },
  { target: "detailsOpacity", kind: "timing", toValue: 1, delay: 240, duration: 300, expression: "withDelay(240, withTiming(1, { duration: 300 }))" },
  { target: "detailsY", kind: "timing", toValue: 0, delay: 240, duration: 380, expression: "withDelay(240, withTiming(0, { duration: 380 }))" },
  { target: "buttonOpacity", kind: "timing", toValue: 1, delay: 380, duration: 240, expression: "withDelay(380, withTiming(1, { duration: 240 }))" },
  { target: "buttonScale", kind: "spring", toValue: 1, delay: 380, damping: 12, stiffness: 220, expression: "withDelay(380, withSpring(1, { damping: 12, stiffness: 220 }))" }
].map((site, index) => {
  const line = FIRST_LINE + index;
  const callsiteId = `${FILE}:${line}:${COLUMN}:${site.kind}:${site.target}`;
  const controls = [
    { key: "delay", id: `${callsiteId}:delay`, label: `${site.target} delay`, defaultValue: site.delay, min: 0, max: 10000, step: 1, unit: "ms" },
    ...(site.kind === "timing"
      ? [{ key: "duration", id: `${callsiteId}:duration`, label: `${site.target} duration`, defaultValue: site.duration, min: 0, max: 10000, step: 1, unit: "ms" }]
      : [
          { key: "damping", id: `${callsiteId}:damping`, label: `${site.target} damping`, defaultValue: site.damping, min: 0, max: 100, step: 0.1 },
          { key: "stiffness", id: `${callsiteId}:stiffness`, label: `${site.target} stiffness`, defaultValue: site.stiffness, min: 1, max: 1000, step: 1 }
        ])
  ];
  return { ...site, line, callsiteId, controls };
});

const CONTROLS = new Map(SITES.flatMap((site) => site.controls.map((control) => [control.id, control])));

function sliderControl({ key: _key, ...control }, value) {
  return { ...control, kind: "slider", value };
}

function buildSchema(valueOf) {
  return {
    id: AUTO_SCHEMA_ID,
    title: "Inspected values",
    version: "1",
    groups: [
      {
        id: "actions",
        label: "Actions",
        controls: [{ id: REPLAY_CONTROL_ID, kind: "trigger", label: "Replay" }]
      },
      ...SITES.map((site) => ({
        id: site.target,
        label: site.target,
        controls: site.controls.map((control) => sliderControl(control, valueOf(control)))
      }))
    ]
  };
}

/** The schema with every slider at its source default. */
export function autoSchema() {
  return buildSchema((control) => control.defaultValue);
}

function isInRange(control, value) {
  return typeof value === "number" && Number.isFinite(value) && value >= control.min && value <= control.max;
}

/** Holds the current value of every slider, like the runtime's live bindings. */
export function createDemoState() {
  const values = new Map([...CONTROLS.values()].map((control) => [control.id, control.defaultValue]));

  function applyOne(controlId, value) {
    const control = CONTROLS.get(controlId);
    if (!control || !isInRange(control, value)) return false;
    values.set(controlId, value);
    return true;
  }

  return {
    /** Applies control.patch / control.commit / control.batchPatch for the `auto` schema; returns whether any value changed. */
    applyControlMessage(message) {
      if (!message || message.schemaId !== AUTO_SCHEMA_ID) return false;
      if (message.type === "control.patch" || message.type === "control.commit") {
        return applyOne(message.controlId, message.value);
      }
      if (message.type === "control.batchPatch" && Array.isArray(message.patches)) {
        let applied = false;
        for (const patch of message.patches) {
          if (patch && applyOne(patch.controlId, patch.value)) applied = true;
        }
        return applied;
      }
      return false;
    },

    /** The schema with the current values, for (re)publishing. */
    schema() {
      return buildSchema((control) => values.get(control.id));
    },

    /** The `animation.started` messages one run of `play()` emits at call time. */
    replayEvents({ nowMs, instanceSeed }) {
      return SITES.map((site, index) => {
        const delayMs = values.get(`${site.callsiteId}:delay`);
        const startedAtRuntimeMs = nowMs + index * STAGGER_MS + delayMs;
        const parameterControls = Object.fromEntries(
          site.controls
            .filter((control) => control.key !== "delay")
            .map((control) => [control.key, { schemaId: AUTO_SCHEMA_ID, controlId: control.id }])
        );
        return {
          delayMs: 0,
          message: {
            type: "animation.started",
            instanceId: `${site.callsiteId}:${startedAtRuntimeMs}:${instanceSeed}`,
            callsiteId: site.callsiteId,
            target: site.target,
            animationKind: site.kind,
            startedAtRuntimeMs,
            startDelayMs: delayMs,
            startControl: { schemaId: AUTO_SCHEMA_ID, controlId: `${site.callsiteId}:delay` },
            toValue: site.toValue,
            config:
              site.kind === "timing"
                ? { duration: site.duration }
                : { damping: site.damping, stiffness: site.stiffness },
            parameterControls,
            source: {
              file: FILE,
              line: site.line,
              column: COLUMN,
              enclosure: [...ENCLOSURE],
              expression: site.expression
            }
          }
        };
      });
    }
  };
}
