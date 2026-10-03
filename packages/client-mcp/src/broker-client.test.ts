import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startBroker, type RuntimeInspectorBroker } from "@runtime-inspector/transport-ws";
import { createBrokerClient, type BrokerClient } from "./broker-client";

let broker: RuntimeInspectorBroker | undefined;
let client: BrokerClient | undefined;
let runtime: WebSocket | undefined;

afterEach(async () => {
  client?.close();
  runtime?.close();
  await broker?.close();
  broker = undefined;
  client = undefined;
  runtime = undefined;
});

const testSchema = {
  id: "test-schema",
  title: "Test",
  groups: [
    {
      id: "group-1",
      label: "Group 1",
      controls: [
        {
          id: "speed",
          kind: "slider",
          label: "Speed",
          defaultValue: 1,
          min: 0,
          max: 10
        },
        {
          id: "replay",
          kind: "trigger",
          label: "Replay"
        }
      ]
    }
  ]
};

describe("createBrokerClient", () => {
  it("connects and receives the replayed schema", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    const schemas = client.getSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.id).toBe("test-schema");
    expect(client.getValues("test-schema").speed).toBe(1);
  });

  it("sends a control.commit for a valid value (an agent decision is a commit) and rejects an invalid one without sending", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    const runtimeMessages: Array<{ type?: string; controlId?: string; value?: unknown }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    client.setValue("test-schema", "speed", 5);
    await wait(50);

    expect(
      runtimeMessages.some(
        (message) => message.type === "control.commit" && message.controlId === "speed" && message.value === 5
      )
    ).toBe(true);

    expect(() => client!.setValue("test-schema", "speed", "not-a-number")).toThrow(/WRONG_TYPE/);
  });

  it("rejects setValue with an out-of-range slider value and reports the valid range", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    expect(() => client!.setValue("test-schema", "speed", 9999)).toThrow(/OUT_OF_RANGE.*between 0 and 10/);
  });

  it("rejects connect() with UNAUTHORIZED when broker requires a token and none is given", async () => {
    broker = startBroker({ port: 0, token: "secret" });
    await waitForBrokerPort(broker);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await expect(client.connect()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("delivers a control.trigger to the runtime when firing a trigger", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    const runtimeMessages: Array<{ type?: string; controlId?: string }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    client.fireTrigger("test-schema", "replay");
    await wait(50);

    expect(
      runtimeMessages.some(
        (message) => message.type === "control.trigger" && message.controlId === "replay"
      )
    ).toBe(true);
  });

  it("exposes schema staleness that follows runtime.status", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    expect(client.isStale("test-schema")).toBe(false);

    runtime.close();
    await wait(50);

    expect(client.isStale("test-schema")).toBe(true);
  });

  it("blocks setValue, batchSet, and fireTrigger while a schema is stale", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    runtime.close();
    await wait(50);

    expect(client.isStale("test-schema")).toBe(true);
    expect(() => client!.setValue("test-schema", "speed", 5)).toThrow(/Schema "test-schema" is stale/);
    expect(() => client!.batchSet("test-schema", { speed: 5 })).toThrow(/Schema "test-schema" is stale/);
    expect(() => client!.fireTrigger("test-schema", "replay")).toThrow(/Schema "test-schema" is stale/);
    expect(client.getValues("test-schema").speed).toBe(1);
  });
});

const scenesSchema = {
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
          scene: { url: "myapp://product", active: true, reachable: true }
        },
        {
          id: "like-burst",
          kind: "trigger",
          label: "Like",
          description: "Heart pop on like",
          scene: { active: false, reachable: false }
        },
        { id: "plain", kind: "trigger", label: "Plain" }
      ]
    }
  ]
};

function animationStarted(instanceId: string, startedAtRuntimeMs: number, startDelayMs?: number) {
  return {
    type: "animation.started",
    instanceId,
    callsiteId: `callsite-${instanceId}`,
    target: "cover.opacity",
    animationKind: "timing",
    startedAtRuntimeMs,
    config: { duration: 300 },
    ...(startDelayMs !== undefined ? { startDelayMs } : {})
  };
}

describe("scenes and animation observation", () => {
  it("lists scenes from the cached scenes schema and flags staleness", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, scenesSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    expect(client.getScenes()).toEqual([
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
        active: false,
        reachable: false,
        stale: false
      }
    ]);

    runtime.close();
    await wait(50);
    expect(client.getScenes().every((scene) => scene.stale)).toBe(true);
  });

  it("returns no scenes when no scenes schema is cached", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, testSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    expect(client.getScenes()).toEqual([]);
  });

  it("keeps the latest scene.status per scene and notifies listeners until unsubscribed", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, scenesSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    const seen: string[] = [];
    const unsubscribe = client.onSceneStatus((status) => seen.push(`${status.sceneId}:${status.phase}`));

    runtime.send(JSON.stringify({ type: "scene.status", sceneId: "product-reveal", phase: "navigating", atRuntimeMs: 10 }));
    runtime.send(JSON.stringify({ type: "scene.status", sceneId: "product-reveal", phase: "playing", atRuntimeMs: 20 }));
    await wait(50);

    expect(seen).toEqual(["product-reveal:navigating", "product-reveal:playing"]);
    expect(client.getSceneStatus("product-reveal")).toMatchObject({ phase: "playing", atRuntimeMs: 20 });
    expect(client.getSceneStatus("like-burst")).toBeUndefined();

    unsubscribe();
    runtime.send(
      JSON.stringify({
        type: "scene.status",
        sceneId: "like-burst",
        phase: "failed",
        atRuntimeMs: 30,
        code: "UNREACHABLE",
        reason: "No link."
      })
    );
    await wait(50);

    expect(seen).toHaveLength(2);
    expect(client.getSceneStatus("like-burst")).toMatchObject({ phase: "failed", code: "UNREACHABLE" });
  });

  it("filters buffered animations by call time with a 1 ms tolerance", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, scenesSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    runtime.send(JSON.stringify(animationStarted("early", 900)));
    // Started at 1100 but called at 1000 (100 ms delay).
    runtime.send(JSON.stringify(animationStarted("delayed", 1100, 100)));
    // Call time 999.5 is within the 1 ms tolerance of 1000.
    runtime.send(JSON.stringify(animationStarted("tolerated", 999.5)));
    runtime.send(JSON.stringify(animationStarted("late", 1500)));
    await wait(50);

    expect(client.getAnimationsSince(1000).map((animation) => animation.instanceId)).toEqual([
      "delayed",
      "tolerated",
      "late"
    ]);
    expect(client.getAnimationsSince(2000)).toEqual([]);
  });

  it("bounds the animation buffer to the latest 300 messages", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, scenesSchema);

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    for (let index = 0; index < 320; index += 1) {
      runtime.send(JSON.stringify(animationStarted(`anim-${index}`, index)));
    }
    await wait(200);

    const buffered = client.getAnimationsSince(0);
    expect(buffered).toHaveLength(300);
    expect(buffered[0]?.instanceId).toBe("anim-20");
    expect(buffered[299]?.instanceId).toBe("anim-319");
  });

  it("fires a scene as a trigger on the scenes schema", async () => {
    broker = startBroker({ port: 0 });
    await waitForBrokerPort(broker);
    runtime = await openRuntime(`ws://127.0.0.1:${broker.port}`, scenesSchema);

    const runtimeMessages: Array<{ type?: string; schemaId?: string; controlId?: string }> = [];
    runtime.on("message", (data) => runtimeMessages.push(JSON.parse(data.toString())));

    client = createBrokerClient({ url: `ws://127.0.0.1:${broker.port}` });
    await client.connect();
    await wait(50);

    client.fireTrigger("scenes", "product-reveal");
    await wait(50);

    expect(
      runtimeMessages.some(
        (message) =>
          message.type === "control.trigger" &&
          message.schemaId === "scenes" &&
          message.controlId === "product-reveal"
      )
    ).toBe(true);
  });
});

function openRuntime(url: string, schema: unknown) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          type: "handshake.hello",
          protocolVersion: "0.3",
          role: "runtime",
          clientId: "runtime-test"
        })
      );
      socket.send(
        JSON.stringify({
          type: "schema.publish",
          schema
        })
      );
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrokerPort(activeBroker: RuntimeInspectorBroker) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (activeBroker.port > 0) return;
    await wait(10);
  }

  throw new Error("Broker did not start listening.");
}
