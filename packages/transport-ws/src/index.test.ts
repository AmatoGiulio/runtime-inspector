import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startBroker, type RuntimeInspectorBroker } from "./index";

let broker: RuntimeInspectorBroker | undefined;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

describe("Runtime Inspector WebSocket broker", () => {
  it("replays the latest runtime schema to a panel that connects later", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);

    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-test"
      })
    );
    runtime.send(
      JSON.stringify({
        type: "schema.publish",
        schema: { id: "test-schema", title: "Test", groups: [] }
      })
    );

    await wait(50);

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string; schema?: { id?: string } }> = [];
    panel.on("message", (data) => messages.push(JSON.parse(data.toString())));
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-test"
      })
    );

    await wait(100);
    runtime.close();
    panel.close();

    expect(
      messages.some(
        (message) =>
          message.type === "schema.publish" && message.schema?.id === "test-schema"
      )
    ).toBe(true);
  });
});

describe("Runtime Inspector protocol version enforcement", () => {
  it("rejects a mismatched protocol version and disconnects the socket", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string; code?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.1",
        role: "panel",
        clientId: "panel-old"
      })
    );

    await closed;

    expect(messages.some((message) => message.type === "error" && message.code === "VERSION_MISMATCH")).toBe(
      true
    );
  });

  it("accepts a correct-version hello", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-ok"
      })
    );

    await wait(50);
    socket.close();

    expect(messages.some((message) => message.type === "handshake.accept")).toBe(true);
  });
});

describe("Runtime Inspector panel token enforcement", () => {
  it("rejects a panel hello without a token when the broker requires one", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string; code?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-no-token"
      })
    );

    await closed;

    expect(messages.some((message) => message.type === "error" && message.code === "UNAUTHORIZED")).toBe(
      true
    );
  });

  it("accepts a panel hello with the correct token", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-token",
        token: "secret"
      })
    );

    await wait(50);
    socket.close();

    expect(messages.some((message) => message.type === "handshake.accept")).toBe(true);
  });

  it("accepts a runtime hello without a token even when the broker requires one for panels", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-no-token"
      })
    );

    await wait(50);
    socket.close();

    expect(messages.some((message) => message.type === "handshake.accept")).toBe(true);
  });
});

describe("Runtime Inspector protocol 0.3 broker rules", () => {
  it("forwards control.trigger to the runtime but never caches or replays it", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const runtimeMessages: Array<{ type?: string }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));

    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-trigger"
      })
    );
    await wait(30);

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-trigger"
      })
    );
    await wait(30);

    panel.send(
      JSON.stringify({
        type: "control.trigger",
        schemaId: "test-schema",
        controlId: "replay",
        source: "panel"
      })
    );
    await wait(50);

    expect(
      runtimeMessages.some(
        (message) => message.type === "control.trigger"
      )
    ).toBe(true);

    // A late-joining panel must never receive a replayed trigger.
    const latePanel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const lateMessages: Array<{ type?: string }> = [];
    latePanel.on("message", (data) => lateMessages.push(JSON.parse(data.toString())));
    latePanel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-late-trigger"
      })
    );
    await wait(50);

    runtime.close();
    panel.close();
    latePanel.close();

    expect(lateMessages.some((message) => message.type === "control.trigger")).toBe(false);
  });

  it("forwards control.commit to the runtime like a patch, without caching", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const runtimeMessages: Array<{ type?: string; value?: unknown }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));

    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-commit"
      })
    );
    await wait(30);

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-commit"
      })
    );
    await wait(30);

    panel.send(
      JSON.stringify({
        type: "control.commit",
        schemaId: "test-schema",
        controlId: "scale",
        value: 1.5,
        source: "panel"
      })
    );
    await wait(50);

    runtime.close();
    panel.close();

    expect(
      runtimeMessages.some(
        (message) => message.type === "control.commit" && message.value === 1.5
      )
    ).toBe(true);
  });

  it("drops the cached schema and forwards schema.dispose to panels", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);

    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-dispose"
      })
    );
    runtime.send(
      JSON.stringify({
        type: "schema.publish",
        schema: { id: "dispose-schema", title: "Test", groups: [] }
      })
    );
    await wait(30);

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const panelMessages: Array<{ type?: string }> = [];
    panel.on("message", (data) => panelMessages.push(JSON.parse(data.toString())));
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-dispose"
      })
    );
    await wait(30);

    runtime.send(
      JSON.stringify({
        type: "schema.dispose",
        schemaId: "dispose-schema",
        source: "runtime"
      })
    );
    await wait(50);

    expect(panelMessages.some((message) => message.type === "schema.dispose")).toBe(true);

    // A late panel joining after dispose must get nothing for that schema.
    const latePanel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const lateMessages: Array<{ type?: string }> = [];
    latePanel.on("message", (data) => lateMessages.push(JSON.parse(data.toString())));
    latePanel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-late-dispose"
      })
    );
    await wait(50);

    runtime.close();
    panel.close();
    latePanel.close();

    expect(lateMessages.some((message) => message.type === "schema.publish")).toBe(false);
  });

  it("keeps the cached schema on a silent runtime disconnect and replays schema + stale status", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);

    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-silent"
      })
    );
    runtime.send(
      JSON.stringify({
        type: "schema.publish",
        schema: { id: "silent-schema", title: "Test", groups: [] }
      })
    );
    await wait(30);

    // Silent disconnect: no schema.dispose sent.
    runtime.close();
    await wait(50);

    const latePanel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const lateMessages: Array<{ type?: string; schema?: { id?: string }; online?: boolean; clientId?: string }> =
      [];
    latePanel.on("message", (data) => lateMessages.push(JSON.parse(data.toString())));
    latePanel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-late-silent"
      })
    );
    await wait(50);
    latePanel.close();

    expect(
      lateMessages.some(
        (message) => message.type === "schema.publish" && message.schema?.id === "silent-schema"
      )
    ).toBe(true);
    expect(
      lateMessages.some(
        (message) =>
          message.type === "runtime.status" &&
          message.clientId === "runtime-silent" &&
          message.online === false
      )
    ).toBe(true);
  });
});

describe("Runtime Inspector workspace role (RFC 0004)", () => {
  it("rejects a workspace hello without a token when the broker requires one", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string; code?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-no-token"
      })
    );

    await closed;

    expect(messages.some((message) => message.type === "error" && message.code === "UNAUTHORIZED")).toBe(
      true
    );
  });

  it("accepts a workspace hello with the correct token", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);
    const socket = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const messages: Array<{ type?: string }> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-token",
        token: "secret"
      })
    );

    await wait(50);
    socket.close();

    expect(messages.some((message) => message.type === "handshake.accept")).toBe(true);
  });

  it("forwards source.apply from a panel to the workspace client, never to a runtime", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);

    const runtime = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const runtimeMessages: Array<{ type?: string }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));
    runtime.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "runtime",
        clientId: "runtime-apply"
      })
    );

    const workspace = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const workspaceMessages: Array<{ type?: string; requests?: unknown }> = [];
    workspace.on("message", (data) => workspaceMessages.push(JSON.parse(data.toString())));
    workspace.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-apply"
      })
    );

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-apply"
      })
    );
    await wait(30);

    panel.send(
      JSON.stringify({
        type: "source.apply",
        schemaId: "test-schema",
        requests: [
          {
            controlId: "moveX",
            kind: "slider",
            anchor: {
              file: "src/Card.tsx",
              line: 42,
              column: 8,
              enclosure: ["Card"],
              name: "moveX",
              init: "0"
            },
            value: 42
          }
        ]
      })
    );
    await wait(50);

    runtime.close();
    workspace.close();
    panel.close();

    expect(workspaceMessages.some((message) => message.type === "source.apply")).toBe(true);
    expect(runtimeMessages.some((message) => message.type === "source.apply")).toBe(false);
  });

  it("forwards source.applyResult from a workspace client to panels", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);

    const workspace = await openSocket(`ws://127.0.0.1:${broker.port}`);
    workspace.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-result"
      })
    );

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const panelMessages: Array<{ type?: string }> = [];
    panel.on("message", (data) => panelMessages.push(JSON.parse(data.toString())));
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-result"
      })
    );
    await wait(30);

    workspace.send(
      JSON.stringify({
        type: "source.applyResult",
        schemaId: "test-schema",
        results: [{ controlId: "moveX", ok: true, written: "42", previous: "0" }]
      })
    );
    await wait(50);

    workspace.close();
    panel.close();

    expect(panelMessages.some((message) => message.type === "source.applyResult")).toBe(true);
  });

  it("never replays source.apply or source.applyResult to a late-joining client", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);

    const panel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    panel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-early"
      })
    );

    const workspace = await openSocket(`ws://127.0.0.1:${broker.port}`);
    workspace.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-early"
      })
    );
    await wait(30);

    panel.send(
      JSON.stringify({
        type: "source.apply",
        schemaId: "test-schema",
        requests: [
          {
            controlId: "moveX",
            kind: "slider",
            anchor: {
              file: "src/Card.tsx",
              line: 42,
              column: 8,
              enclosure: ["Card"],
              name: "moveX",
              init: "0"
            },
            value: 42
          }
        ]
      })
    );
    await wait(30);

    workspace.send(
      JSON.stringify({
        type: "source.applyResult",
        schemaId: "test-schema",
        results: [{ controlId: "moveX", ok: true, written: "42", previous: "0" }]
      })
    );
    await wait(50);

    const lateWorkspace = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const lateWorkspaceMessages: Array<{ type?: string }> = [];
    lateWorkspace.on("message", (data) => lateWorkspaceMessages.push(JSON.parse(data.toString())));
    lateWorkspace.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "workspace",
        clientId: "workspace-late"
      })
    );

    const latePanel = await openSocket(`ws://127.0.0.1:${broker.port}`);
    const latePanelMessages: Array<{ type?: string }> = [];
    latePanel.on("message", (data) => latePanelMessages.push(JSON.parse(data.toString())));
    latePanel.send(
      JSON.stringify({
        type: "handshake.hello",
        protocolVersion: "0.3",
        role: "panel",
        clientId: "panel-late"
      })
    );
    await wait(50);

    panel.close();
    workspace.close();
    lateWorkspace.close();
    latePanel.close();

    expect(lateWorkspaceMessages.some((message) => message.type === "source.apply")).toBe(false);
    expect(latePanelMessages.some((message) => message.type === "source.applyResult")).toBe(false);
  });
});

function openSocket(url: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrokerPort(broker: RuntimeInspectorBroker) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (broker.port > 0) return;
    await wait(10);
  }

  throw new Error("Broker did not start listening.");
}
