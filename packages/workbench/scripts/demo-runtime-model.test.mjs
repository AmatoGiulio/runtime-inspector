import assert from "node:assert/strict";
import test from "node:test";
import { PanelSchemaSchema, safeParseRIPMessage } from "@runtime-inspector/protocol";
import {
  AUTO_SCHEMA_ID,
  SCENES_SCHEMA_ID,
  autoSchema,
  createDemoState,
  likeBurstEvents,
  scenesSchema
} from "./demo-runtime-model.mjs";

const TITLE_Y_DELAY = "demo/ProductRevealDemo.tsx:36:4:timing:titleY:delay";

function controlsOf(schema) {
  return schema.groups.flatMap((group) => group.controls);
}

function eventFor(events, target) {
  return events.find((event) => event.message.target === target)?.message;
}

test("the demo schema validates, as a schema and as a publish message", () => {
  assert.equal(PanelSchemaSchema.safeParse(autoSchema()).success, true);
  assert.equal(PanelSchemaSchema.safeParse(createDemoState().schema()).success, true);
  assert.notEqual(
    safeParseRIPMessage(JSON.stringify({ type: "schema.publish", schema: autoSchema() })),
    undefined
  );
  assert.equal(autoSchema().id, AUTO_SCHEMA_ID);
  assert.equal(controlsOf(autoSchema()).filter((control) => control.kind === "trigger").length, 1);
});

test("replayEvents produces 8 valid, delay-aware messages", () => {
  const events = createDemoState().replayEvents({ nowMs: 1000, instanceSeed: 1 });
  assert.equal(events.length, 8);
  for (const { delayMs, message } of events) {
    assert.equal(delayMs, 0);
    assert.notEqual(safeParseRIPMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
    assert.equal(message.schemaId, undefined);
    assert.ok(message.startControl);
  }
  assert.deepEqual(
    events.map((event) => event.message.target),
    ["coverOpacity", "coverScale", "titleOpacity", "titleY", "detailsOpacity", "detailsY", "buttonOpacity", "buttonScale"]
  );
  assert.deepEqual(
    events.map((event) => event.message.startDelayMs),
    [0, 0, 140, 140, 240, 240, 380, 380]
  );
  assert.equal(events[3].message.startedAtRuntimeMs, 1000 + 3 * 0.4 + 140);
  assert.deepEqual(eventFor(events, "titleY").config, { duration: 380 });
  assert.deepEqual(eventFor(events, "buttonScale").config, { damping: 12, stiffness: 220 });
  assert.deepEqual(Object.keys(eventFor(events, "buttonScale").parameterControls), ["damping", "stiffness"]);
  assert.equal(eventFor(events, "titleY").source.expression, "withDelay(140, withTiming(0, { duration: 380 }))");
  assert.equal(eventFor(events, "titleY").callsiteId, TITLE_Y_DELAY.replace(/:delay$/, ""));
});

test("every referenced control exists in the schema", () => {
  const ids = new Set(controlsOf(autoSchema()).map((control) => control.id));
  for (const { message } of createDemoState().replayEvents({ nowMs: 0, instanceSeed: 1 })) {
    assert.ok(ids.has(message.startControl.controlId), message.startControl.controlId);
    assert.equal(message.startControl.schemaId, AUTO_SCHEMA_ID);
    for (const ref of Object.values(message.parameterControls)) {
      assert.equal(ref.schemaId, AUTO_SCHEMA_ID);
      assert.ok(ids.has(ref.controlId), ref.controlId);
    }
  }
});

test("a committed delay applies to the next replay", () => {
  const state = createDemoState();
  const before = eventFor(state.replayEvents({ nowMs: 1000, instanceSeed: 1 }), "titleY");
  assert.equal(
    state.applyControlMessage({ type: "control.commit", schemaId: "auto", controlId: TITLE_Y_DELAY, value: 500 }),
    true
  );
  const after = eventFor(state.replayEvents({ nowMs: 1000, instanceSeed: 2 }), "titleY");
  assert.equal(after.startDelayMs, 500);
  assert.equal(after.startedAtRuntimeMs, before.startedAtRuntimeMs + (500 - 140));
  assert.equal(after.config.duration, before.config.duration, "config keeps the source literals");
  const published = controlsOf(state.schema()).find((control) => control.id === TITLE_Y_DELAY);
  assert.equal(published.value, 500);
  assert.equal(published.defaultValue, 140);
});

test("patch and batchPatch update values too", () => {
  const state = createDemoState();
  state.applyControlMessage({ type: "control.patch", schemaId: "auto", controlId: TITLE_Y_DELAY, value: 90 });
  assert.equal(eventFor(state.replayEvents({ nowMs: 0, instanceSeed: 1 }), "titleY").startDelayMs, 90);
  const durationId = "demo/ProductRevealDemo.tsx:33:4:timing:coverOpacity:duration";
  state.applyControlMessage({
    type: "control.batchPatch",
    schemaId: "auto",
    patches: [
      { controlId: TITLE_Y_DELAY, value: 10 },
      { controlId: durationId, value: 1234 }
    ]
  });
  const events = state.replayEvents({ nowMs: 0, instanceSeed: 2 });
  assert.equal(eventFor(events, "titleY").startDelayMs, 10);
  assert.equal(
    controlsOf(state.schema()).find((control) => control.id === durationId).value,
    1234
  );
});

test("out-of-range, non-finite and unknown values are ignored", () => {
  const state = createDemoState();
  const base = { type: "control.commit", schemaId: "auto" };
  for (const value of [-1, 10001, Number.NaN, Number.POSITIVE_INFINITY, "500", null]) {
    assert.equal(state.applyControlMessage({ ...base, controlId: TITLE_Y_DELAY, value }), false);
  }
  assert.equal(state.applyControlMessage({ ...base, controlId: "unknown", value: 5 }), false);
  assert.equal(state.applyControlMessage({ ...base, schemaId: "other", controlId: TITLE_Y_DELAY, value: 5 }), false);
  assert.equal(state.applyControlMessage({ type: "control.trigger", schemaId: "auto", controlId: "replay" }), false);
  assert.equal(eventFor(state.replayEvents({ nowMs: 0, instanceSeed: 1 }), "titleY").startDelayMs, 140);
});

test("instance ids differ across seeds", () => {
  const state = createDemoState();
  const a = state.replayEvents({ nowMs: 5, instanceSeed: 1 }).map((event) => event.message.instanceId);
  const b = state.replayEvents({ nowMs: 5, instanceSeed: 2 }).map((event) => event.message.instanceId);
  assert.equal(new Set([...a, ...b]).size, 16);
});

test("the scenes schema validates and marks the active scene", () => {
  const schema = scenesSchema("product-reveal");
  assert.equal(PanelSchemaSchema.safeParse(schema).success, true);
  assert.notEqual(safeParseRIPMessage(JSON.stringify({ type: "schema.publish", schema })), undefined);
  assert.equal(schema.id, SCENES_SCHEMA_ID);
  assert.equal(schema.title, "Scenes");
  assert.deepEqual(schema.groups.map((group) => group.label), ["Store"]);
  const controls = controlsOf(schema);
  assert.deepEqual(
    controls.map((control) => [control.id, control.label, control.binding]),
    [
      ["product-reveal", "Product reveal", "scenes.product-reveal"],
      ["like-burst", "Like", "scenes.like-burst"]
    ]
  );
  assert.deepEqual(controls[0].scene, {
    url: "exp://127.0.0.1:8090/--/product",
    active: true,
    reachable: true
  });
  assert.deepEqual(controls[1].scene, {
    url: "exp://127.0.0.1:8090/--/like",
    active: false,
    reachable: true
  });
  const switched = controlsOf(scenesSchema("like-burst"));
  assert.deepEqual(switched.map((control) => control.scene.active), [false, true]);
});

test("likeBurstEvents produces 3 valid messages with the ring fade delayed", () => {
  const events = likeBurstEvents({ nowMs: 2000, instanceSeed: 1 });
  assert.equal(events.length, 3);
  for (const { delayMs, message } of events) {
    assert.equal(delayMs, 0);
    assert.notEqual(safeParseRIPMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
    assert.equal(message.type, "animation.started");
  }
  assert.deepEqual(
    events.map((event) => [event.message.target, event.message.animationKind]),
    [
      ["heartScale", "spring"],
      ["ringScale", "timing"],
      ["ringOpacity", "timing"]
    ]
  );
  assert.deepEqual(eventFor(events, "ringScale").config, { duration: 420 });
  assert.deepEqual(eventFor(events, "ringOpacity").config, { duration: 300 });
  assert.equal(eventFor(events, "ringOpacity").startDelayMs, 120);
  assert.equal(eventFor(events, "ringOpacity").startedAtRuntimeMs, 2000 + 2 * 0.4 + 120);
  assert.equal(eventFor(events, "heartScale").startedAtRuntimeMs, 2000);
  const other = likeBurstEvents({ nowMs: 2000, instanceSeed: 2 });
  assert.equal(
    new Set([...events, ...other].map((event) => event.message.instanceId)).size,
    6
  );
});
