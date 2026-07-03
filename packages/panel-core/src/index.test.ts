import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelSession, type WebSocketLike } from "./index";
import type { PanelSchema } from "@runtime-inspector/protocol";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const testSchema: PanelSchema = {
  id: "demo",
  title: "Demo",
  groups: [
    {
      id: "group-1",
      label: "Group 1",
      controls: [
        { id: "speed", kind: "slider", label: "Speed", defaultValue: 1, min: 0, max: 10 },
        { id: "enabled", kind: "toggle", label: "Enabled", defaultValue: false },
        {
          id: "spring",
          kind: "spring",
          label: "Spring",
          defaultValue: { damping: 10, stiffness: 100, mass: 1 }
        },
        { id: "easing", kind: "bezier", label: "Easing", defaultValue: [0.4, 0, 0.2, 1] },
        { id: "replayTrigger", kind: "trigger", label: "Replay" }
      ]
    }
  ]
};

function createSession(overrides: Partial<Parameters<typeof createPanelSession>[0]> = {}) {
  let nowValue = 0;
  const session = createPanelSession({
    url: "ws://test",
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocketLike,
    now: () => nowValue,
    ...overrides
  });
  return {
    session,
    setNow: (value: number) => {
      nowValue = value;
    }
  };
}

function latestSocket() {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

function publishSchema(socket: FakeSocket, schema: PanelSchema = testSchema) {
  socket.open();
  socket.receive({ type: "schema.publish", schema });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPanelSession", () => {
  it("throttles slider sends: immediate state update, capped sends, flush on commit", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.setValue("demo", "speed", 2);
    expect(session.getState().values.demo?.speed).toBe(2);
    const sentPatchesAfterFirst = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(sentPatchesAfterFirst).toHaveLength(1);

    session.setValue("demo", "speed", 3);
    session.setValue("demo", "speed", 4);
    expect(session.getState().values.demo?.speed).toBe(4);
    const sentPatchesAfterThrottled = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(sentPatchesAfterThrottled).toHaveLength(1);

    session.commitValue("demo", "speed");
    const sentPatchesAfterCommit = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(sentPatchesAfterCommit).toHaveLength(1);
    const sentCommits = socket.sent.filter((raw) => JSON.parse(raw).type === "control.commit");
    expect(sentCommits).toHaveLength(1);
    expect(JSON.parse(sentCommits[0]!).value).toBe(4);
  });

  it("rejects invalid outgoing value with a notice and does not send", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.setValue("demo", "enabled", "not-a-boolean");
    expect(session.getState().notice).toBe(
      'Invalid value for Enabled: toggle "enabled" expects a boolean, got string'
    );
    const patches = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patches).toHaveLength(0);
  });

  it("stops reconnecting on UNAUTHORIZED", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    socket.open();
    socket.receive({ type: "error", code: "UNAUTHORIZED", message: "nope" });

    expect(session.getState().status).toBe("rejected");
    expect(session.getState().notice).toBe("Broker rejected this panel: missing or wrong token.");

    const instancesBefore = FakeSocket.instances.length;
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.instances.length).toBe(instancesBefore);
  });

  it("sends batchPatch and fires replay trigger after delay on compare apply", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.setValue("demo", "speed", 5);
    session.commitValue("demo", "speed");
    session.saveCompareSlot("A", "demo");

    session.setValue("demo", "speed", 9);
    session.commitValue("demo", "speed");

    session.applyCompareSlot("A", "demo");
    expect(session.getState().values.demo?.speed).toBe(5);

    const batchPatches = socket.sent.filter((raw) => JSON.parse(raw).type === "control.batchPatch");
    expect(batchPatches).toHaveLength(1);
    expect(JSON.parse(batchPatches[0]!).committed).toBe(true);

    const triggerPatchesBefore = socket.sent.filter(
      (raw) => JSON.parse(raw).type === "control.trigger" && JSON.parse(raw).controlId === "replayTrigger"
    );
    expect(triggerPatchesBefore).toHaveLength(0);

    vi.advanceTimersByTime(80);
    const triggerPatchesAfter = socket.sent.filter(
      (raw) => JSON.parse(raw).type === "control.trigger" && JSON.parse(raw).controlId === "replayTrigger"
    );
    expect(triggerPatchesAfter).toHaveLength(1);

    expect(session.getState().lastPatch?.label).toBe("Applied A");
  });

  it("exports TypeScript preset for a schema with spring and bezier values", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.setValue("demo", "spring", { damping: 12, stiffness: 150, mass: 1.2 });
    session.setValue("demo", "easing", [0.25, 0.1, 0.25, 1]);

    const output = session.exportTypeScript("demo");
    expect(output).toContain("export const demopreset = ");
    expect(output).toContain("export const demopresetSpring = ");
    expect(output).toContain('"damping": 12');
    expect(output).toContain('"stiffness": 150');
    expect(output).toContain("// withSpring(targetValue, demopresetSpring)");
    expect(output).toContain("export const demopresetEasing = Easing.bezier(0.3, 0.1, 0.3, 1);");
    expect(output).toContain('// import { Easing, withSpring } from "react-native-reanimated";');
  });

  it("sends control.trigger on fireTrigger", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.fireTrigger("demo", "replayTrigger");

    const triggers = socket.sent.filter((raw) => JSON.parse(raw).type === "control.trigger");
    expect(triggers).toHaveLength(1);
    expect(JSON.parse(triggers[0]!).controlId).toBe("replayTrigger");
    const patches = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patches).toHaveLength(0);
  });

  it("marks a schema stale on runtime.status offline and blocks outgoing messages", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({ type: "runtime.status", online: false, clientId: "runtime-demo", schemaId: "demo" });

    expect(session.getState().staleSchemaIds.demo).toBe(true);

    session.setValue("demo", "speed", 5);
    expect(session.getState().notice).toBe("Runtime disconnected - controls are frozen.");
    const patchesWhileStale = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patchesWhileStale).toHaveLength(0);

    session.fireTrigger("demo", "replayTrigger");
    const triggersWhileStale = socket.sent.filter((raw) => JSON.parse(raw).type === "control.trigger");
    expect(triggersWhileStale).toHaveLength(0);

    session.commitValue("demo", "speed");
    const commitsWhileStale = socket.sent.filter((raw) => JSON.parse(raw).type === "control.commit");
    expect(commitsWhileStale).toHaveLength(0);

    // Schema and values remain visible while stale.
    expect(session.getState().schemas.some((schema) => schema.id === "demo")).toBe(true);

    // Republish clears staleness.
    socket.receive({ type: "runtime.status", online: true, clientId: "runtime-demo", schemaId: "demo" });
    expect(session.getState().staleSchemaIds.demo).toBe(false);
  });

  it("removes the schema and its values on schema.dispose", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    expect(session.getState().schemas.some((schema) => schema.id === "demo")).toBe(true);

    socket.receive({ type: "schema.dispose", schemaId: "demo", source: "runtime" });

    expect(session.getState().schemas.some((schema) => schema.id === "demo")).toBe(false);
    expect(session.getState().values.demo).toBeUndefined();
    expect(session.getState().staleSchemaIds.demo).toBeUndefined();
  });

  it("updates state on incoming control.patch and control.batchPatch", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({ type: "control.patch", schemaId: "demo", controlId: "speed", value: 7 });
    expect(session.getState().values.demo?.speed).toBe(7);

    socket.receive({
      type: "control.batchPatch",
      schemaId: "demo",
      patches: [
        { controlId: "speed", value: 3 },
        { controlId: "enabled", value: true }
      ]
    });
    expect(session.getState().values.demo?.speed).toBe(3);
    expect(session.getState().values.demo?.enabled).toBe(true);
  });

  it("rejects invalid incoming control.patch without mutating state", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    expect(session.getState().values.demo?.enabled).toBe(false);

    socket.receive({ type: "control.patch", schemaId: "demo", controlId: "enabled", value: "yes" });

    expect(session.getState().values.demo?.enabled).toBe(false);
    expect(session.getState().notice).toBe(
      'Ignored invalid incoming value for Enabled: toggle "enabled" expects a boolean, got string'
    );
  });

  it("rejects invalid incoming control.commit without mutating state", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    expect(session.getState().values.demo?.speed).toBe(1);

    socket.receive({ type: "control.commit", schemaId: "demo", controlId: "speed", value: 99 });

    expect(session.getState().values.demo?.speed).toBe(1);
    expect(session.getState().notice).toBe(
      'Ignored invalid incoming value for Speed: slider "speed" expects a finite number between 0 and 10, got 99'
    );
  });

  it("rejects an invalid incoming batchPatch atomically", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({
      type: "control.batchPatch",
      schemaId: "demo",
      patches: [
        { controlId: "speed", value: 4 },
        { controlId: "enabled", value: "yes" }
      ]
    });

    expect(session.getState().values.demo?.speed).toBe(1);
    expect(session.getState().values.demo?.enabled).toBe(false);
    expect(session.getState().notice).toBe(
      'Ignored invalid incoming batch value for Enabled: toggle "enabled" expects a boolean, got string'
    );
  });

  it("commits the current value even when no throttled slider patch is pending", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    session.commitValue("demo", "speed");

    const commits = socket.sent
      .filter((raw) => JSON.parse(raw).type === "control.commit")
      .map((raw) => JSON.parse(raw));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ schemaId: "demo", controlId: "speed", value: 1 });
  });
});

describe("createPanelSession with multiple schemas sharing control ids", () => {
  const schemaA: PanelSchema = {
    id: "schema-a",
    title: "Schema A",
    groups: [
      {
        id: "group-1",
        label: "Group 1",
        controls: [
          { id: "scale", kind: "slider", label: "Scale", defaultValue: 1, min: 0, max: 10 },
          { id: "replay", kind: "trigger", label: "Replay" }
        ]
      }
    ]
  };

  const schemaB: PanelSchema = {
    id: "schema-b",
    title: "Schema B",
    groups: [
      {
        id: "group-1",
        label: "Group 1",
        controls: [
          { id: "scale", kind: "slider", label: "Scale", defaultValue: 1, min: 0, max: 10 },
          { id: "replay", kind: "trigger", label: "Replay" }
        ]
      }
    ]
  };

  it("keeps pending throttled patches separate per schema for colliding controlIds", () => {
    const { session, setNow } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, schemaA);
    socket.receive({ type: "schema.publish", schema: schemaB });

    setNow(0);
    session.setValue("schema-a", "scale", 2);
    setNow(10);
    session.setValue("schema-b", "scale", 3);

    // Both should have sent an immediate patch (first send per schema/control is not throttled).
    const patchesAfterFirstSends = socket.sent
      .filter((raw) => JSON.parse(raw).type === "control.patch")
      .map((raw) => JSON.parse(raw));
    expect(patchesAfterFirstSends).toHaveLength(2);
    expect(patchesAfterFirstSends.find((p) => p.schemaId === "schema-a")?.value).toBe(2);
    expect(patchesAfterFirstSends.find((p) => p.schemaId === "schema-b")?.value).toBe(3);

    // Now issue throttled updates within the throttle window for both schemas' "scale" control.
    setNow(15);
    session.setValue("schema-a", "scale", 4);
    setNow(20);
    session.setValue("schema-b", "scale", 5);

    // Neither should have sent yet (still within throttle window), both timers pending independently.
    const patchesBeforeFlush = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patchesBeforeFlush).toHaveLength(2);

    // Commit both — before the fix, the second schema's pending patch would have clobbered the first
    // (since pendingPatches was keyed by controlId alone), causing a wrong send or a lost commit.
    session.commitValue("schema-a", "scale");
    session.commitValue("schema-b", "scale");

    const commits = socket.sent
      .filter((raw) => JSON.parse(raw).type === "control.commit")
      .map((raw) => JSON.parse(raw));
    expect(commits).toHaveLength(2);
    expect(commits.find((c) => c.schemaId === "schema-a")?.value).toBe(4);
    expect(commits.find((c) => c.schemaId === "schema-b")?.value).toBe(5);
  });

  it("stores and applies compare slot snapshots independently per schema", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, schemaA);
    socket.receive({ type: "schema.publish", schema: schemaB });

    session.setValue("schema-a", "scale", 6);
    session.commitValue("schema-a", "scale");
    session.setValue("schema-b", "scale", 8);
    session.commitValue("schema-b", "scale");

    session.saveCompareSlot("A", "schema-a");
    session.saveCompareSlot("A", "schema-b");

    expect(session.getState().compareSlots["schema-a"]?.A?.scale).toBe(6);
    expect(session.getState().compareSlots["schema-b"]?.A?.scale).toBe(8);

    // Mutate current values so apply is observable.
    session.setValue("schema-a", "scale", 1);
    session.commitValue("schema-a", "scale");
    session.setValue("schema-b", "scale", 2);
    session.commitValue("schema-b", "scale");

    session.applyCompareSlot("A", "schema-a");

    expect(session.getState().values["schema-a"]?.scale).toBe(6);
    // Schema B's live values must remain untouched by applying schema A's slot.
    expect(session.getState().values["schema-b"]?.scale).toBe(2);

    const batchPatches = socket.sent
      .filter((raw) => JSON.parse(raw).type === "control.batchPatch")
      .map((raw) => JSON.parse(raw));
    expect(batchPatches).toHaveLength(1);
    expect(batchPatches[0].schemaId).toBe("schema-a");
    expect(batchPatches[0].patches).toEqual([{ controlId: "scale", value: 6 }]);
  });

  it("keeps values state separated per schema for colliding controlIds (regression)", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, schemaA);
    socket.receive({ type: "schema.publish", schema: schemaB });

    session.setValue("schema-a", "scale", 7);
    session.setValue("schema-b", "scale", 9);

    expect(session.getState().values["schema-a"]?.scale).toBe(7);
    expect(session.getState().values["schema-b"]?.scale).toBe(9);
  });
});
