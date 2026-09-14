import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelSchema, RIPMessage } from "@runtime-inspector/protocol";

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function makeSchema(id: string): PanelSchema {
  return {
    id,
    title: id,
    groups: [
      {
        id: "controls",
        label: "Controls",
        controls: [
          {
            id: "amount",
            kind: "slider",
            label: "Amount",
            defaultValue: 1,
            min: 0,
            max: 10,
            binding: `${id}.amount`
          },
          {
            id: "enabled",
            kind: "toggle",
            label: "Enabled",
            defaultValue: false,
            binding: `${id}.enabled`
          },
          {
            id: "replay",
            kind: "trigger",
            label: "Replay",
            binding: `${id}.replay`
          }
        ]
      }
    ]
  };
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("attachRuntimeInspectorProtocolClient", () => {
  it("replays all active schemas after a valid panel handshake", async () => {
    const { attachRuntimeInspectorProtocolClient, definePanel } = await import("./index");
    definePanel(makeSchema("alpha"), { reconnect: false }).connect();
    definePanel(makeSchema("beta"), { reconnect: false }).connect();

    const sent: RIPMessage[] = [];
    const client = attachRuntimeInspectorProtocolClient({ send: (message) => sent.push(message) });

    client.receive({
      type: "handshake.hello",
      protocolVersion: "0.3",
      role: "panel",
      clientId: "rozenite-test"
    });

    expect(sent[0]).toMatchObject({ type: "handshake.accept", protocolVersion: "0.3" });
    expect(
      sent.filter((message) => message.type === "schema.publish").map((message) => message.schema.id)
    ).toEqual(["alpha", "beta"]);
    expect(sent.filter((message) => message.type === "runtime.status")).toHaveLength(2);

    client.dispose();
  });

  it("routes patch, commit, batch patch and trigger through the normal runtime bindings", async () => {
    const {
      attachRuntimeInspectorProtocolClient,
      bindTrigger,
      bindValue,
      definePanel
    } = await import("./index");

    definePanel(makeSchema("demo"), { reconnect: false }).connect();
    const amount = vi.fn();
    const enabled = vi.fn();
    const replay = vi.fn();
    bindValue("demo.amount", amount);
    bindValue("demo.enabled", enabled);
    bindTrigger("demo.replay", replay);

    const client = attachRuntimeInspectorProtocolClient({ send: () => {} });
    client.receive({
      type: "handshake.hello",
      protocolVersion: "0.3",
      role: "panel",
      clientId: "rozenite-test"
    });

    client.receive({
      type: "control.patch",
      schemaId: "demo",
      controlId: "amount",
      value: 4,
      source: "panel"
    });
    client.receive({
      type: "control.commit",
      schemaId: "demo",
      controlId: "amount",
      value: 5,
      source: "panel"
    });
    client.receive({
      type: "control.batchPatch",
      schemaId: "demo",
      source: "panel",
      committed: true,
      patches: [
        { controlId: "amount", value: 6 },
        { controlId: "enabled", value: true }
      ]
    });
    client.receive({
      type: "control.trigger",
      schemaId: "demo",
      controlId: "replay",
      source: "panel"
    });

    expect(amount.mock.calls.map(([value]) => value)).toEqual([4, 5, 6]);
    expect(enabled).toHaveBeenCalledWith(true);
    expect(replay).toHaveBeenCalledTimes(1);

    client.dispose();
  });

  it("publishes new sessions and disposes disconnected sessions after handshake", async () => {
    const { attachRuntimeInspectorProtocolClient, definePanel } = await import("./index");
    const sent: RIPMessage[] = [];
    const client = attachRuntimeInspectorProtocolClient({ send: (message) => sent.push(message) });
    client.receive({
      type: "handshake.hello",
      protocolVersion: "0.3",
      role: "panel",
      clientId: "rozenite-test"
    });

    const panel = definePanel(makeSchema("live"), { reconnect: false });
    panel.connect();
    expect(sent.some((message) => message.type === "schema.publish" && message.schema.id === "live")).toBe(true);

    panel.disconnect();
    expect(sent.some((message) => message.type === "schema.dispose" && message.schemaId === "live")).toBe(true);

    client.dispose();
  });

  it("rejects a mismatched protocol version before exposing runtime state", async () => {
    const { attachRuntimeInspectorProtocolClient, definePanel } = await import("./index");
    definePanel(makeSchema("demo"), { reconnect: false }).connect();
    const sent: RIPMessage[] = [];
    const client = attachRuntimeInspectorProtocolClient({ send: (message) => sent.push(message) });

    client.receive({
      type: "handshake.hello",
      protocolVersion: "0.2",
      role: "panel",
      clientId: "old-client"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "error", code: "VERSION_MISMATCH" });
    client.dispose();
  });
});
