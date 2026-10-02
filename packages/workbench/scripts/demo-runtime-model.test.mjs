import assert from "node:assert/strict";
import test from "node:test";
import { PanelSchemaSchema, safeParseRIPMessage } from "@runtime-inspector/protocol";
import { autoSchema, cardTransitionSchema, replayEvents } from "./demo-runtime-model.mjs";

test("both demo schemas validate", () => {
  assert.equal(PanelSchemaSchema.safeParse(cardTransitionSchema()).success, true);
  assert.equal(PanelSchemaSchema.safeParse(autoSchema()).success, true);
  assert.equal(safeParseRIPMessage(JSON.stringify({ type: "schema.publish", schema: cardTransitionSchema() })) !== undefined, true);
  assert.equal(safeParseRIPMessage(JSON.stringify({ type: "schema.publish", schema: autoSchema() })) !== undefined, true);
});

test("replayEvents produces 8 valid messages with the expected shape", () => {
  const events = replayEvents({ nowMs: 1000, instanceSeed: 1 });
  assert.equal(events.length, 8);
  for (const { message } of events) {
    assert.notEqual(safeParseRIPMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  const timing = events.filter((event) => event.delayMs === 0);
  const spring = events.filter((event) => event.delayMs === 220);
  assert.equal(timing.length, 4);
  assert.equal(spring.length, 4);
  for (const { message } of timing) {
    assert.equal(message.animationKind, "timing");
    assert.ok(message.parameterControls?.duration);
  }
  for (const { message } of spring) {
    assert.equal(message.animationKind, "spring");
    assert.equal(message.configControlId, "spring");
    assert.equal(message.parameterControls, undefined);
  }
});

test("parameter controls reference existing auto controls", () => {
  const ids = new Set(autoSchema().groups.flatMap((group) => group.controls.map((control) => control.id)));
  for (const { message } of replayEvents({ nowMs: 0, instanceSeed: 1 })) {
    const ref = message.parameterControls?.duration;
    if (ref) {
      assert.equal(ref.schemaId, "auto");
      assert.ok(ids.has(ref.controlId), ref.controlId);
    }
  }
});

test("instance ids differ between seeds", () => {
  const a = replayEvents({ nowMs: 5, instanceSeed: 1 }).map((e) => e.message.instanceId);
  const b = replayEvents({ nowMs: 5, instanceSeed: 2 }).map((e) => e.message.instanceId);
  assert.equal(new Set([...a, ...b]).size, 16);
});
