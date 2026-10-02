// Pure fixture model for the development-only demo runtime. No I/O.

const PROPS = ["moveX", "rotate", "scale", "opacity"];
const TIMING_TARGETS = { moveX: -110, rotate: -14, scale: 0.82, opacity: 0.62 };
const TIMING_LINES = { moveX: 74, rotate: 75, scale: 76, opacity: 77 };
const SPRING_LINES = { moveX: 83, rotate: 84, scale: 85, opacity: 86 };
const SPRING_DELAY_MS = 220;
const STAGGER_MS = 0.4;
const FILE = "demo/App.tsx";
const COLUMN = 4;
const ENCLOSURE = ["App", "replayTransition"];

export function cardTransitionSchema() {
  return {
    id: "card-transition",
    title: "card-transition",
    version: "1",
    groups: [
      {
        id: "motion",
        label: "Motion",
        controls: [
          {
            id: "moveX",
            kind: "slider",
            label: "Move X",
            defaultValue: 0,
            value: 0,
            min: -120,
            max: 120,
            step: 1,
            unit: "px"
          },
          {
            id: "rotate",
            kind: "slider",
            label: "Rotate",
            defaultValue: 0,
            value: 0,
            min: -18,
            max: 18,
            step: 1,
            unit: "deg"
          },
          {
            id: "scale",
            kind: "slider",
            label: "Scale",
            defaultValue: 1,
            value: 1,
            min: 0.7,
            max: 1.35,
            step: 0.01
          },
          {
            id: "opacity",
            kind: "slider",
            label: "Opacity",
            defaultValue: 1,
            value: 1,
            min: 0,
            max: 1,
            step: 0.01
          },
          {
            id: "color",
            kind: "color",
            label: "Color",
            defaultValue: "#f5f7fb",
            value: "#f5f7fb",
            format: "hex"
          }
        ]
      },
      {
        id: "easing",
        label: "Easing",
        controls: [
          {
            id: "spring",
            kind: "spring",
            label: "Replay return spring",
            defaultValue: { damping: 14, stiffness: 180, mass: 1 },
            value: { damping: 14, stiffness: 180, mass: 1 }
          },
          {
            id: "easing",
            kind: "bezier",
            label: "Easing",
            defaultValue: [0.22, 1, 0.36, 1],
            value: [0.22, 1, 0.36, 1]
          }
        ]
      },
      {
        id: "actions",
        label: "Actions",
        controls: [{ id: "replay", kind: "trigger", label: "Replay" }]
      }
    ]
  };
}

export function autoDurationControlId(prop) {
  return `${FILE}:${TIMING_LINES[prop]}:${COLUMN}:timing:card.${prop}:duration`;
}

export function autoSchema() {
  return {
    id: "auto",
    title: "Inspected values",
    version: "1",
    groups: [
      {
        id: "timing",
        label: "Timing",
        controls: PROPS.map((prop) => ({
          id: autoDurationControlId(prop),
          kind: "slider",
          label: `card.${prop} duration`,
          defaultValue: 260,
          value: 260,
          min: 0,
          max: 10000,
          step: 1,
          unit: "ms"
        }))
      }
    ]
  };
}

export function replayEvents({ nowMs, instanceSeed }) {
  const events = [];

  PROPS.forEach((prop, index) => {
    const line = TIMING_LINES[prop];
    const callsiteId = `${FILE}:${line}:${COLUMN}:timing:card.${prop}`;
    const startedAtRuntimeMs = nowMs + index * STAGGER_MS;
    events.push({
      delayMs: 0,
      message: {
        type: "animation.started",
        instanceId: `${callsiteId}:${startedAtRuntimeMs}:${instanceSeed}`,
        callsiteId,
        schemaId: "card-transition",
        target: `card.${prop}`,
        animationKind: "timing",
        startedAtRuntimeMs,
        toValue: TIMING_TARGETS[prop],
        config: { duration: 260 },
        parameterControls: {
          duration: { schemaId: "auto", controlId: autoDurationControlId(prop) }
        },
        source: {
          file: FILE,
          line,
          column: COLUMN,
          enclosure: [...ENCLOSURE],
          expression: `withTiming(${TIMING_TARGETS[prop]}, { duration: 260, easing })`
        }
      }
    });
  });

  PROPS.forEach((prop, index) => {
    const line = SPRING_LINES[prop];
    const callsiteId = `${FILE}:${line}:${COLUMN}:spring:card.${prop}`;
    const startedAtRuntimeMs = nowMs + SPRING_DELAY_MS + index * STAGGER_MS;
    events.push({
      delayMs: SPRING_DELAY_MS,
      message: {
        type: "animation.started",
        instanceId: `${callsiteId}:${startedAtRuntimeMs}:${instanceSeed}`,
        callsiteId,
        schemaId: "card-transition",
        target: `card.${prop}`,
        animationKind: "spring",
        startedAtRuntimeMs,
        config: {},
        configControlId: "spring",
        source: {
          file: FILE,
          line,
          column: COLUMN,
          enclosure: [...ENCLOSURE],
          expression: `withSpring(targets.${prop}, spring)`
        }
      }
    });
  });

  return events;
}
