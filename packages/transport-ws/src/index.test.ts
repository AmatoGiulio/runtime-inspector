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
        protocolVersion: "0.2",
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
        protocolVersion: "0.2",
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
        protocolVersion: "0.2",
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
        protocolVersion: "0.2",
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
        protocolVersion: "0.2",
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
        protocolVersion: "0.2",
        role: "runtime",
        clientId: "runtime-no-token"
      })
    );

    await wait(50);
    socket.close();

    expect(messages.some((message) => message.type === "handshake.accept")).toBe(true);
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
