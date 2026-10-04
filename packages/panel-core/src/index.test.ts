import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPanelSession, listScenes, type WebSocketLike } from "./index";
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

const anchor = {
  file: "src/Demo.tsx",
  line: 10,
  column: 2,
  enclosure: ["Demo"],
  name: "speed",
  init: "1"
};

const anchoredSchema: PanelSchema = {
  id: "anchored-demo",
  title: "Anchored Demo",
  groups: [
    {
      id: "group-1",
      label: "Group 1",
      controls: [
        { id: "speed", kind: "slider", label: "Speed", defaultValue: 1, min: 0, max: 10, source: anchor },
        {
          id: "enabled",
          kind: "toggle",
          label: "Enabled",
          defaultValue: false,
          source: { ...anchor, name: "enabled", init: "false" }
        },
        { id: "unanchored", kind: "slider", label: "Unanchored", defaultValue: 5, min: 0, max: 10 },
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

  it("clears pending throttled patches when a schema is disposed", () => {
    const { session, setNow } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    setNow(0);
    session.setValue("demo", "speed", 2);
    setNow(10);
    session.setValue("demo", "speed", 3);

    const patchesBeforeDispose = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patchesBeforeDispose).toHaveLength(1);

    socket.receive({ type: "schema.dispose", schemaId: "demo", source: "runtime" });
    vi.advanceTimersByTime(100);

    const patchesAfterDispose = socket.sent.filter((raw) => JSON.parse(raw).type === "control.patch");
    expect(patchesAfterDispose).toHaveLength(1);
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

describe("createPanelSession applySource", () => {
  it("sends source.apply for all anchored controls with current session values", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, anchoredSchema);

    session.setValue("anchored-demo", "speed", 7);

    session.applySource("anchored-demo");

    const applies = socket.sent
      .filter((raw) => JSON.parse(raw).type === "source.apply")
      .map((raw) => JSON.parse(raw));
    expect(applies).toHaveLength(1);
    expect(applies[0].schemaId).toBe("anchored-demo");
    expect(applies[0].requests).toEqual([
      { controlId: "speed", kind: "slider", anchor, value: 7 },
      {
        controlId: "enabled",
        kind: "toggle",
        anchor: { ...anchor, name: "enabled", init: "false" },
        value: false
      }
    ]);
  });

  it("filters to the given controlIds", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, anchoredSchema);

    session.applySource("anchored-demo", ["enabled"]);

    const applies = socket.sent
      .filter((raw) => JSON.parse(raw).type === "source.apply")
      .map((raw) => JSON.parse(raw));
    expect(applies).toHaveLength(1);
    expect(applies[0].requests).toEqual([
      {
        controlId: "enabled",
        kind: "toggle",
        anchor: { ...anchor, name: "enabled", init: "false" },
        value: false
      }
    ]);
  });

  it("sends nothing when no requested control is anchored", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, anchoredSchema);

    session.applySource("anchored-demo", ["unanchored"]);
    session.applySource("anchored-demo", ["replayTrigger"]);

    const applies = socket.sent.filter((raw) => JSON.parse(raw).type === "source.apply");
    expect(applies).toHaveLength(0);
  });

  it("updates lastApplyResult on source.applyResult", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, anchoredSchema);

    socket.receive({
      type: "source.applyResult",
      schemaId: "anchored-demo",
      results: [{ controlId: "speed", ok: true, written: "42", previous: "1" }]
    });

    expect(session.getState().lastApplyResult?.schemaId).toBe("anchored-demo");
    expect(session.getState().lastApplyResult?.results).toEqual([
      { controlId: "speed", ok: true, written: "42", previous: "1" }
    ]);
  });

  it("surfaces an actionable notice for EXPRESSION_MISMATCH", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, anchoredSchema);

    socket.receive({
      type: "source.applyResult",
      schemaId: "anchored-demo",
      results: [{ controlId: "speed", ok: false, code: "EXPRESSION_MISMATCH", message: "expr changed" }]
    });

    expect(session.getState().notice).toBe("file changed since launch — hot-reload and retry");
    expect(session.getState().lastApplyResult?.results).toEqual([
      { controlId: "speed", ok: false, code: "EXPRESSION_MISMATCH", message: "expr changed" }
    ]);
  });
});

describe("animation literal write-back (RFC 0007)", () => {
  const durationLiteral = {
    file: "src/WelcomeDemo.tsx",
    line: 41,
    column: 4,
    enclosure: ["WelcomeDemo", "play"],
    target: "titleY.value",
    callee: "withTiming" as const,
    parameter: "duration" as const,
    init: "380"
  };
  const delayLiteral = { ...durationLiteral, parameter: "delay" as const, init: null };
  const autoSchema: PanelSchema = {
    id: "auto",
    title: "Inspected values",
    groups: [
      {
        id: "auto",
        label: "Auto-inspected",
        controls: [
          {
            id: "duration",
            kind: "slider",
            label: "titleY duration",
            defaultValue: 380,
            min: 0,
            max: 10000,
            literal: durationLiteral
          },
          {
            id: "delay",
            kind: "slider",
            label: "titleY delay",
            defaultValue: 0,
            min: 0,
            max: 10000,
            literal: delayLiteral
          },
          { id: "speed", kind: "slider", label: "Speed", defaultValue: 1, min: 0, max: 10, source: anchor }
        ]
      }
    ]
  };

  it("sends literal instead of anchor for literal-anchored controls", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, autoSchema);
    session.setValue("auto", "duration", 420);

    session.applySource("auto");

    const applies = socket.sent
      .filter((raw) => JSON.parse(raw).type === "source.apply")
      .map((raw) => JSON.parse(raw));
    expect(applies).toHaveLength(1);
    expect(applies[0].requests).toEqual([
      { controlId: "duration", kind: "slider", literal: durationLiteral, value: 420 },
      { controlId: "delay", kind: "slider", literal: delayLiteral, value: 0 },
      { controlId: "speed", kind: "slider", anchor, value: 1 }
    ]);
  });

  it("lists literal controls whose value differs from their default", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, autoSchema);
    publishSchema(socket, anchoredSchema);

    expect(session.pendingLiteralChanges()).toEqual([]);

    session.setValue("auto", "delay", 140);
    session.setValue("auto", "speed", 5);
    session.setValue("anchored-demo", "speed", 7);

    expect(session.pendingLiteralChanges()).toEqual([
      { schemaId: "auto", controlId: "delay", label: "titleY delay", from: 0, to: 140 }
    ]);
    expect(session.pendingLiteralChanges("auto")).toHaveLength(1);
    expect(session.pendingLiteralChanges("anchored-demo")).toEqual([]);

    session.setValue("auto", "delay", 0);
    expect(session.pendingLiteralChanges()).toEqual([]);
  });

  it("skips stale schemas", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, autoSchema);
    session.setValue("auto", "duration", 420);
    expect(session.pendingLiteralChanges()).toHaveLength(1);

    socket.receive({ type: "runtime.status", online: false, clientId: "runtime-demo", schemaId: "auto" });

    expect(session.pendingLiteralChanges()).toEqual([]);
    expect(session.pendingLiteralChanges("auto")).toEqual([]);
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

describe("automatic animation observation state", () => {
  it("collects a started animation and completes the matching span", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({
      type: "animation.started",
      instanceId: "anim-1",
      callsiteId: "src/Card.tsx:20:4:timing:card.moveX",
      schemaId: "demo",
      target: "card.moveX",
      animationKind: "timing",
      startedAtRuntimeMs: 1000,
      toValue: -110,
      config: { duration: 260 }
    });

    expect(session.getState().runtimeAnimations).toHaveLength(1);
    expect(session.getState().runtimeAnimations[0]).toMatchObject({
      instanceId: "anim-1",
      target: "card.moveX",
      animationKind: "timing",
      startedAtRuntimeMs: 1000,
      resolvedConfig: { duration: 260 },
      expectedDurationMs: 260,
      durationBasis: "declared"
    });

    socket.receive({
      type: "animation.completed",
      instanceId: "anim-1",
      callsiteId: "src/Card.tsx:20:4:timing:card.moveX",
      schemaId: "demo",
      target: "card.moveX",
      animationKind: "timing",
      endedAtRuntimeMs: 1262,
      finished: true,
      current: -110
    });

    expect(session.getState().runtimeAnimations[0]).toMatchObject({
      endedAtRuntimeMs: 1262,
      finished: true,
      current: -110
    });
  });

  const durationControlId = "App.tsx:74:4:timing:card.moveX:duration";
  const parameterControls = {
    duration: { schemaId: "auto", controlId: durationControlId }
  };
  const autoSchema: PanelSchema = {
    id: "auto",
    title: "Inspected values",
    groups: [
      {
        id: "auto",
        label: "Auto-inspected",
        controls: [
          {
            id: durationControlId,
            kind: "slider",
            label: "card.moveX duration",
            defaultValue: 260,
            min: 0,
            max: 10000,
            step: 1,
            unit: "ms",
            binding: `auto.${durationControlId}`
          }
        ]
      }
    ]
  };

  function startTimingWithParameterControls(socket: FakeSocket, duration: number) {
    socket.receive({
      type: "animation.started",
      instanceId: "anim-duration",
      callsiteId: "App.tsx:74:4:timing:card.moveX",
      schemaId: "demo",
      target: "card.moveX",
      animationKind: "timing",
      startedAtRuntimeMs: 1000,
      toValue: -110,
      config: { duration },
      parameterControls
    });
  }

  it("resolves a timing duration from the committed parameter control", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({ type: "schema.publish", schema: autoSchema });

    session.setValue("auto", durationControlId, 400);
    session.commitValue("auto", durationControlId);

    startTimingWithParameterControls(socket, 260);

    const animation = session.getState().runtimeAnimations.at(-1);
    expect(animation?.config).toEqual({ duration: 260 });
    expect(animation?.resolvedConfig.duration).toBe(400);
    expect(animation?.expectedDurationMs).toBe(400);
    expect(animation?.durationBasis).toBe("declared");
  });

  it("falls back to the parameter control's default value when no value is set", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({ type: "schema.publish", schema: autoSchema });

    // The literal carried by the message deliberately differs from the control's
    // default, so this only passes if the control is what gets resolved.
    startTimingWithParameterControls(socket, 120);

    const animation = session.getState().runtimeAnimations.at(-1);
    expect(animation?.resolvedConfig.duration).toBe(260);
    expect(animation?.expectedDurationMs).toBe(260);
    expect(animation?.durationBasis).toBe("declared");
  });

  it("keeps the literal duration when the referenced schema is unknown", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    startTimingWithParameterControls(socket, 260);

    const animation = session.getState().runtimeAnimations.at(-1);
    expect(animation?.resolvedConfig).toEqual({ duration: 260 });
    expect(animation?.expectedDurationMs).toBe(260);
    expect(animation?.durationBasis).toBe("declared");
  });

  it("exposes parameterControls on the animation trace", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    startTimingWithParameterControls(socket, 260);

    expect(session.getState().runtimeAnimations.at(-1)?.parameterControls).toEqual(
      parameterControls
    );
  });

  it("exposes startControl and startDelayMs on the animation trace", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    const startControl = { schemaId: "auto", controlId: "App.tsx:31:4:timing:titleY:delay" };
    socket.receive({
      type: "animation.started",
      instanceId: "anim-delayed",
      callsiteId: "App.tsx:31:4:timing:titleY",
      schemaId: "demo",
      target: "titleY",
      animationKind: "timing",
      startedAtRuntimeMs: 1120,
      toValue: 0,
      config: { duration: 380 },
      startControl,
      startDelayMs: 120
    });

    const animation = session.getState().runtimeAnimations.at(-1);
    expect(animation?.startControl).toEqual(startControl);
    expect(animation?.startDelayMs).toBe(120);
    expect(animation?.startedAtRuntimeMs).toBe(1120);
  });

  it("resolves a literal spring config from its parameter controls and estimates its span", () => {
    const dampingId = "App.tsx:32:4:spring:imageScale:damping";
    const stiffnessId = "App.tsx:32:4:spring:imageScale:stiffness";
    const springSchema: PanelSchema = {
      id: "auto",
      title: "Inspected values",
      groups: [
        {
          id: "auto",
          label: "Auto-inspected",
          controls: [
            {
              id: dampingId,
              kind: "slider",
              label: "imageScale damping",
              defaultValue: 14,
              min: 0,
              max: 100,
              step: 0.1,
              binding: `auto.${dampingId}`
            },
            {
              id: stiffnessId,
              kind: "slider",
              label: "imageScale stiffness",
              defaultValue: 160,
              min: 1,
              max: 1000,
              step: 1,
              binding: `auto.${stiffnessId}`
            }
          ]
        }
      ]
    };
    const springStarted = {
      type: "animation.started" as const,
      callsiteId: "App.tsx:32:4:spring:imageScale",
      schemaId: "demo",
      target: "imageScale",
      animationKind: "spring" as const,
      startedAtRuntimeMs: 1234.5,
      toValue: 1,
      config: { damping: 14, stiffness: 160 },
      parameterControls: {
        damping: { schemaId: "auto", controlId: dampingId },
        stiffness: { schemaId: "auto", controlId: stiffnessId }
      },
      startControl: { schemaId: "auto", controlId: "App.tsx:32:4:spring:imageScale:delay" },
      startDelayMs: 0
    };

    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({ type: "schema.publish", schema: springSchema });

    socket.receive({ ...springStarted, instanceId: "spring-declared" });
    const declared = session.getState().runtimeAnimations.at(-1);
    expect(declared?.resolvedConfig).toEqual({ damping: 14, stiffness: 160 });
    expect(declared?.durationBasis).toBe("spring-estimate");
    expect(declared?.expectedDurationMs).toBeGreaterThan(0);

    session.setValue("auto", dampingId, 40);
    session.commitValue("auto", dampingId);
    session.setValue("auto", stiffnessId, 500);
    session.commitValue("auto", stiffnessId);

    socket.receive({ ...springStarted, instanceId: "spring-tuned" });
    const tuned = session.getState().runtimeAnimations.at(-1);
    expect(tuned?.config).toEqual({ damping: 14, stiffness: 160 });
    expect(tuned?.resolvedConfig).toEqual({ damping: 40, stiffness: 500 });
    expect(tuned?.durationBasis).toBe("spring-estimate");
    expect(tuned?.expectedDurationMs).toBeGreaterThan(0);
    expect(tuned?.expectedDurationMs).not.toBe(declared?.expectedDurationMs);
  });
});

describe("recording timeline state (RFC 0005 M0)", () => {
  it("publishes trace schemas, records ordered chunks, and completes", () => {
    const { session } = createSession({ clientId: "workbench-test" });
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({
      type: "trace.schema.publish",
      schemaId: "demo",
      probes: [{ id: "speed", label: "Speed", valueType: "number", unit: "px" }]
    });

    expect(session.getState().traceSchemas.demo?.[0]?.id).toBe("speed");

    const recordingId = session.startRecording("demo", ["speed"], 60);
    expect(recordingId).toBeDefined();
    expect(
      socket.sent.some((raw) => JSON.parse(raw).type === "recording.start")
    ).toBe(true);

    socket.receive({
      type: "recording.started",
      recordingId,
      schemaId: "demo",
      probeIds: ["speed"],
      sampleRateHz: 60,
      startedAtRuntimeMs: 100
    });
    socket.receive({
      type: "recording.chunk",
      recordingId,
      schemaId: "demo",
      sequence: 0,
      samples: [
        { t: 0, values: { speed: 0 } },
        { t: 16.7, values: { speed: 2 } }
      ]
    });
    socket.receive({
      type: "recording.complete",
      recordingId,
      schemaId: "demo",
      durationMs: 20,
      sampleCount: 2,
      complete: true
    });

    const recording = session.getState().recording;
    expect(recording?.samples).toHaveLength(2);
    expect(recording?.complete).toBe(true);
    expect(recording?.incomplete).toBe(false);
  });

  it("resolves a spring config from the current inspector control and estimates its span", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);

    socket.receive({
      type: "animation.started",
      instanceId: "spring-1",
      callsiteId: "src/Card.tsx:30:4:spring:card.moveX",
      schemaId: "demo",
      target: "card.moveX",
      animationKind: "spring",
      startedAtRuntimeMs: 2000,
      config: {},
      configControlId: "spring"
    });

    const animation = session.getState().runtimeAnimations.at(-1);
    expect(animation?.resolvedConfig).toEqual({
      damping: 10,
      stiffness: 100,
      mass: 1
    });
    expect(animation?.durationBasis).toBe("spring-estimate");
    expect(animation?.expectedDurationMs).toBeGreaterThan(250);
  });

  it("marks a recording incomplete when chunk sequence has a gap", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({
      type: "trace.schema.publish",
      schemaId: "demo",
      probes: [{ id: "speed", valueType: "number" }]
    });

    const recordingId = session.startRecording("demo", ["speed"], 60);
    socket.receive({
      type: "recording.chunk",
      recordingId,
      schemaId: "demo",
      sequence: 1,
      samples: [{ t: 16.7, values: { speed: 1 } }]
    });

    expect(session.getState().recording?.incomplete).toBe(true);
  });
});

describe("recording lifecycle guards", () => {
  it("refuses recording before the broker is connected", () => {
    const { session } = createSession();
    expect(session.startRecording("demo", ["speed"], 60)).toBeUndefined();
    expect(session.getState().notice).toContain("Connect to the Runtime Inspector broker");
  });

  it("refuses unavailable probes and unsupported sample rates", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({
      type: "trace.schema.publish",
      schemaId: "demo",
      probes: [{ id: "speed", valueType: "number" }]
    });

    expect(session.startRecording("demo", ["missing"], 60)).toBeUndefined();
    expect(session.getState().notice).toContain("Unavailable runtime probe");

    expect(session.startRecording("demo", ["speed"], 120)).toBeUndefined();
    expect(session.getState().notice).toContain("between 1 and 60 Hz");
  });

  it("marks an active trace incomplete when the runtime goes offline", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket);
    socket.receive({
      type: "trace.schema.publish",
      schemaId: "demo",
      probes: [{ id: "speed", valueType: "number" }]
    });

    session.startRecording("demo", ["speed"], 60);
    socket.receive({
      type: "runtime.status",
      online: false,
      clientId: "runtime-demo",
      schemaId: "demo"
    });

    expect(session.getState().recording?.complete).toBe(true);
    expect(session.getState().recording?.incomplete).toBe(true);
    expect(session.getState().notice).toContain("trace is incomplete");
  });
});
const scenesSchema: PanelSchema = {
  id: "scenes",
  title: "Scenes",
  groups: [
    {
      id: "Store",
      label: "Store",
      controls: [
        {
          id: "product-reveal",
          kind: "trigger",
          label: "Product reveal",
          binding: "scenes.product-reveal",
          scene: { url: "myapp://product", active: true, reachable: true }
        },
        {
          id: "like-burst",
          kind: "trigger",
          label: "Like",
          description: "Heart pop on like",
          scene: { url: "myapp://product", active: false, reachable: true }
        },
        { id: "not-a-scene", kind: "trigger", label: "Plain trigger" }
      ]
    },
    {
      id: "scenes",
      label: "Scenes",
      controls: [
        { id: "welcome", kind: "trigger", label: "Welcome", scene: { active: false, reachable: false } }
      ]
    }
  ]
};

function sentTriggers(socket: FakeSocket) {
  return socket.sent.map((raw) => JSON.parse(raw)).filter((message) => message.type === "control.trigger");
}

describe("scenes (RFC 0006)", () => {
  it("lists scene triggers in group and control order, skipping plain triggers", () => {
    const { session } = createSession();
    expect(listScenes(session.getState())).toEqual([]);
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, testSchema);
    expect(listScenes(session.getState())).toEqual([]);
    socket.receive({ type: "schema.publish", schema: scenesSchema });

    expect(listScenes(session.getState())).toEqual([
      {
        id: "product-reveal",
        title: "Product reveal",
        group: "Store",
        url: "myapp://product",
        active: true,
        reachable: true,
        stale: false
      },
      {
        id: "like-burst",
        title: "Like",
        group: "Store",
        description: "Heart pop on like",
        url: "myapp://product",
        active: false,
        reachable: true,
        stale: false
      },
      { id: "welcome", title: "Welcome", group: "Scenes", active: false, reachable: false, stale: false }
    ]);
  });

  it("marks listed scenes stale when the scenes runtime goes offline", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    socket.receive({ type: "runtime.status", online: false, clientId: "rt", schemaId: "scenes" });
    expect(listScenes(session.getState()).every((scene) => scene.stale)).toBe(true);
  });

  it("opens a scene by firing a trigger on the scenes schema", () => {
    const { session, setNow } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    setNow(1234);

    expect(session.openScene("product-reveal")).toBe(true);

    expect(sentTriggers(socket)).toEqual([
      expect.objectContaining({ schemaId: "scenes", controlId: "product-reveal" })
    ]);
    expect(session.getState().sceneStatus["product-reveal"]).toEqual({
      phase: "requested",
      requestedAt: 1234
    });
  });

  it("refuses unknown scenes and plain triggers with a notice", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    expect(session.openScene("nope")).toBe(false);
    expect(session.getState().notice).toBe('Unknown scene "nope".');

    publishSchema(socket, scenesSchema);
    expect(session.openScene("nope")).toBe(false);
    expect(session.openScene("not-a-scene")).toBe(false);
    expect(session.getState().notice).toBe('Unknown scene "not-a-scene".');
    expect(sentTriggers(socket)).toHaveLength(0);
    expect(session.getState().sceneStatus).toEqual({});
  });

  it("refuses to open a scene while the scenes schema is stale", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    socket.receive({ type: "runtime.status", online: false, clientId: "rt", schemaId: "scenes" });

    expect(session.openScene("product-reveal")).toBe(false);
    expect(session.getState().notice).toBe("The app is not connected; the scene cannot be opened.");
    expect(sentTriggers(socket)).toHaveLength(0);
    expect(session.getState().sceneStatus["product-reveal"]).toBeUndefined();
  });

  it("records scene.status and keeps requestedAt", () => {
    const { session, setNow } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    setNow(500);
    session.openScene("product-reveal");

    socket.receive({ type: "scene.status", sceneId: "product-reveal", phase: "navigating", atRuntimeMs: 510 });
    expect(session.getState().sceneStatus["product-reveal"]).toEqual({
      phase: "navigating",
      requestedAt: 500,
      atRuntimeMs: 510
    });

    socket.receive({ type: "scene.status", sceneId: "product-reveal", phase: "playing", atRuntimeMs: 900 });
    expect(session.getState().sceneStatus["product-reveal"]).toEqual({
      phase: "playing",
      requestedAt: 500,
      atRuntimeMs: 900
    });

    socket.receive({
      type: "scene.status",
      sceneId: "like-burst",
      phase: "failed",
      atRuntimeMs: 950,
      code: "MOUNT_TIMEOUT",
      reason: "No screen mounted."
    });
    expect(session.getState().sceneStatus["like-burst"]).toEqual({
      phase: "failed",
      atRuntimeMs: 950,
      code: "MOUNT_TIMEOUT",
      reason: "No screen mounted."
    });
  });

  it("fails requested and navigating scenes when the scenes runtime goes offline", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    session.openScene("product-reveal");
    session.openScene("like-burst");
    socket.receive({ type: "scene.status", sceneId: "like-burst", phase: "navigating", atRuntimeMs: 10 });
    session.openScene("welcome");
    socket.receive({ type: "scene.status", sceneId: "welcome", phase: "playing", atRuntimeMs: 20 });

    socket.receive({ type: "runtime.status", online: false, clientId: "rt", schemaId: "scenes" });

    const status = session.getState().sceneStatus;
    const reason = "The app disconnected while opening the scene (it may have reloaded).";
    expect(status["product-reveal"]).toMatchObject({ phase: "failed", reason });
    expect(status["like-burst"]).toMatchObject({ phase: "failed", reason });
    expect(status.welcome?.phase).toBe("playing");
    // The cancelled timeouts must not fire later.
    vi.advanceTimersByTime(10_000);
    expect(session.getState().sceneStatus["product-reveal"]?.reason).toBe(reason);
  });

  it("does not fail scenes when another schema goes offline", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, testSchema);
    socket.receive({ type: "schema.publish", schema: scenesSchema });
    session.openScene("product-reveal");
    socket.receive({ type: "runtime.status", online: false, clientId: "rt", schemaId: "demo" });
    expect(session.getState().sceneStatus["product-reveal"]?.phase).toBe("requested");
  });

  it("fails a scene that gets no scene.status within 8 seconds", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    session.openScene("product-reveal");

    vi.advanceTimersByTime(7999);
    expect(session.getState().sceneStatus["product-reveal"]?.phase).toBe("requested");
    vi.advanceTimersByTime(1);
    expect(session.getState().sceneStatus["product-reveal"]).toMatchObject({
      phase: "failed",
      reason: "The app did not answer. Is it running a Runtime Inspector version with scenes?"
    });
  });

  it("cancels the answer timeout once the app reports any status", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    session.openScene("product-reveal");
    vi.advanceTimersByTime(3000);
    socket.receive({ type: "scene.status", sceneId: "product-reveal", phase: "playing", atRuntimeMs: 3000 });

    vi.advanceTimersByTime(20_000);
    expect(session.getState().sceneStatus["product-reveal"]?.phase).toBe("playing");
  });

  it("clears scene timers on dispose", () => {
    const { session } = createSession();
    session.connect();
    const socket = latestSocket();
    publishSchema(socket, scenesSchema);
    session.openScene("product-reveal");
    session.dispose();

    vi.advanceTimersByTime(20_000);
    expect(session.getState().sceneStatus["product-reveal"]?.phase).toBe("requested");
  });
});
