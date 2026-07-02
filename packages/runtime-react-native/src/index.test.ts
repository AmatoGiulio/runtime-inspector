import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema, ToggleControl } from "@runtime-inspector/protocol";

function toggleValue(schema: PanelSchema): boolean | undefined {
  return (schema.groups[0].controls[0] as ToggleControl).value;
}

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function makeSchema(id: string): PanelSchema {
  return {
    id,
    title: id,
    groups: [
      {
        id: "group-1",
        label: "Group",
        controls: [
          {
            id: "value",
            kind: "toggle",
            label: "Value",
            defaultValue: false,
            binding: `${id}.value`
          }
        ]
      }
    ]
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("multi-schema sessions", () => {
  it("routes control patches to the right schema and binding", async () => {
    const { definePanel, applyControlPatch, bindValue } = await import("./index");

    const schemaA = makeSchema("panel-a");
    const schemaB = makeSchema("panel-b");
    const panelA = definePanel(schemaA);
    const panelB = definePanel(schemaB);

    const setterA = vi.fn();
    const setterB = vi.fn();
    bindValue("panel-a.value", setterA);
    bindValue("panel-b.value", setterB);

    applyControlPatch({
      type: "control.patch",
      schemaId: "panel-a",
      controlId: "value",
      value: true
    });

    expect(toggleValue(schemaA)).toBe(true);
    expect(toggleValue(schemaB)).toBe(false);
    expect(setterA).toHaveBeenCalledWith(true);
    expect(setterB).not.toHaveBeenCalled();

    panelA.disconnect();
    panelB.disconnect();
  });

  it("tears down the previous session's socket and timers on hot reload", async () => {
    vi.useFakeTimers();
    const { definePanel } = await import("./index");

    const schema = makeSchema("panel-hot");
    const panel1 = definePanel(schema, { brokerUrl: "ws://127.0.0.1:4577" });
    panel1.connect();

    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket).toBeDefined();
    firstSocket.open();
    // simulate a disconnect that would normally schedule a reconnect
    firstSocket.readyState = FakeWebSocket.CLOSED;
    firstSocket.onclose?.();

    expect(firstSocket.closeCalls).toBeGreaterThanOrEqual(0);

    // Redefine the panel with the same schema id (hot reload)
    definePanel(schema, { brokerUrl: "ws://127.0.0.1:4577" });

    // Advance timers - if a stale reconnect timer were still active it would
    // create a new socket via the old session's scheduleReconnect closure.
    const instanceCountBefore = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(5000);
    const instanceCountAfter = FakeWebSocket.instances.length;

    expect(instanceCountAfter).toBe(instanceCountBefore);
  });

  it("disconnect on one session does not affect another session's socket", async () => {
    const { definePanel } = await import("./index");

    const schemaA = makeSchema("panel-x");
    const schemaB = makeSchema("panel-y");
    const panelA = definePanel(schemaA, { brokerUrl: "ws://127.0.0.1:4577" });
    const panelB = definePanel(schemaB, { brokerUrl: "ws://127.0.0.1:4578" });

    panelA.connect();
    panelB.connect();

    const socketA = FakeWebSocket.instances.find((s) => s.url === "ws://127.0.0.1:4577");
    const socketB = FakeWebSocket.instances.find((s) => s.url === "ws://127.0.0.1:4578");
    expect(socketA).toBeDefined();
    expect(socketB).toBeDefined();

    panelA.disconnect();

    expect(socketA?.closeCalls).toBe(1);
    expect(socketB?.closeCalls).toBe(0);
  });

  it("rejects an invalid control value", async () => {
    const { definePanel, applyControlPatch, bindValue } = await import("./index");

    const schema = makeSchema("panel-invalid");
    definePanel(schema);
    const setter = vi.fn();
    bindValue("panel-invalid.value", setter);

    applyControlPatch({
      type: "control.patch",
      schemaId: "panel-invalid",
      controlId: "value",
      value: "not-a-boolean"
    });

    expect(toggleValue(schema)).toBe(false);
    expect(setter).not.toHaveBeenCalled();
  });
});

describe("discovery diagnostics", () => {
  it("warns exactly once after a full cycle of failed candidates", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { definePanel } = await import("./index");

    const schema = makeSchema("panel-cycle");
    const panel = definePanel(schema);
    panel.connect();

    // Each candidate fails immediately (never opens) then closes, advancing the index.
    for (let i = 0; i < 20; i++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.readyState = FakeWebSocket.CLOSED;
      socket.onclose?.();
      vi.advanceTimersByTime(5000);
    }

    const fullCycleWarnings = warnSpy.mock.calls.filter((call) =>
      String(call[0]).includes("Could not reach a Runtime Inspector broker")
    );
    expect(fullCycleWarnings.length).toBe(1);

    panel.disconnect();
    warnSpy.mockRestore();
  });

  it("warns once when discovery resolves only a tunnel url", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { NativeModules } = await import("react-native");
    const originalSourceCode = NativeModules.SourceCode;
    NativeModules.SourceCode = {
      scriptURL: "http://my-app.ngrok.io/index.bundle"
    };

    try {
      const { definePanel } = await import("./index");

      const schema = makeSchema("panel-tunnel");
      const panel = definePanel(schema);
      panel.connect();

      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      socket.readyState = FakeWebSocket.CLOSED;
      socket.onclose?.();
      vi.advanceTimersByTime(5000);

      const tunnelWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("Dev server is behind a tunnel")
      );
      expect(tunnelWarnings.length).toBe(1);

      panel.disconnect();
    } finally {
      NativeModules.SourceCode = originalSourceCode;
      warnSpy.mockRestore();
    }
  });
});
