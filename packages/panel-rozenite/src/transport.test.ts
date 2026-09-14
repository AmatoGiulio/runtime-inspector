import { afterEach, describe, expect, it, vi } from "vitest";
import { getRozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import { connectFakePair, waitForMessage } from "@rozenite/testing";
import { createPanelSession } from "@runtime-inspector/panel-core";
import type { PanelSchema, RIPMessage } from "@runtime-inspector/protocol";
import { createRozenitePanelSocket } from "./transport";
import {
  RIP_EVENT,
  RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
  RUNTIME_READY_EVENT,
  type RuntimeInspectorRozeniteEvents
} from "./shared";

const schemaA: PanelSchema = {
  id: "schema-a",
  title: "Schema A",
  groups: [
    {
      id: "main",
      label: "Main",
      controls: [
        { id: "amount", kind: "slider", label: "Amount", defaultValue: 1, min: 0, max: 10 },
        { id: "enabled", kind: "toggle", label: "Enabled", defaultValue: false },
        { id: "color", kind: "color", label: "Color", defaultValue: "#ff0000" },
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
      id: "main",
      label: "Main",
      controls: [{ id: "amount", kind: "slider", label: "Amount", defaultValue: 2, min: 0, max: 10 }]
    }
  ]
};

afterEach(() => {
  vi.useRealTimers();
});

describe("RozenitePanelSocket + panel-core", () => {
  it("receives multiple schemas and sends patch, commit and trigger as RIP messages", async () => {
    const { device, panel } = connectFakePair();
    const deviceClient = await getRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>(
      RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
      { channel: device }
    );
    const panelClient = await getRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>(
      RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
      { channel: panel }
    );

    const received: RIPMessage[] = [];
    deviceClient.onMessage(RIP_EVENT, ({ message }) => {
      received.push(message);
      if (message.type === "handshake.hello") {
        deviceClient.send(RIP_EVENT, {
          message: {
            type: "handshake.accept",
            protocolVersion: "0.3",
            brokerId: "direct-runtime",
            clientId: message.clientId
          }
        });
        deviceClient.send(RIP_EVENT, { message: { type: "schema.publish", schema: schemaA } });
        deviceClient.send(RIP_EVENT, { message: { type: "schema.publish", schema: schemaB } });
      }
    });

    const session = createPanelSession({
      url: "rozenite://runtime-inspector",
      createSocket: () => createRozenitePanelSocket(panelClient)
    });
    session.connect();

    await vi.waitFor(() => expect(session.getState().schemas).toHaveLength(2));
    expect(session.getState().schemas.map((schema) => schema.id)).toEqual(["schema-a", "schema-b"]);

    session.setValue("schema-a", "amount", 4);
    session.commitValue("schema-a", "amount");
    session.fireTrigger("schema-a", "replay");

    await vi.waitFor(() => {
      expect(received.some((message) => message.type === "control.patch" && message.schemaId === "schema-a")).toBe(true);
      expect(received.some((message) => message.type === "control.commit" && message.schemaId === "schema-a")).toBe(true);
      expect(received.some((message) => message.type === "control.trigger" && message.schemaId === "schema-a")).toBe(true);
    });

    session.dispose();
    deviceClient.close();
    panelClient.close();
  });

  it("marks old schemas stale on runtime replacement and revives only republished schemas", async () => {
    const { device, panel } = connectFakePair();
    const deviceClient = await getRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>(
      RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
      { channel: device }
    );
    const panelClient = await getRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>(
      RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
      { channel: panel }
    );

    let handshakes = 0;
    deviceClient.onMessage(RIP_EVENT, ({ message }) => {
      if (message.type !== "handshake.hello") return;
      handshakes += 1;
      deviceClient.send(RIP_EVENT, {
        message: {
          type: "handshake.accept",
          protocolVersion: "0.3",
          brokerId: "direct-runtime",
          clientId: message.clientId
        }
      });
      deviceClient.send(RIP_EVENT, { message: { type: "schema.publish", schema: schemaA } });
      if (handshakes === 1) {
        deviceClient.send(RIP_EVENT, { message: { type: "schema.publish", schema: schemaB } });
      }
    });

    const session = createPanelSession({
      url: "rozenite://runtime-inspector",
      createSocket: () => createRozenitePanelSocket(panelClient)
    });
    session.connect();
    await vi.waitFor(() => expect(session.getState().schemas).toHaveLength(2));

    deviceClient.send(RUNTIME_READY_EVENT, { protocolVersion: "0.3", generationId: "generation-1" });
    await waitForMessage(deviceClient, RIP_EVENT, { timeoutMs: 1000 }, ({ message }) => message.type === "handshake.hello").catch(() => undefined);
    deviceClient.send(RUNTIME_READY_EVENT, { protocolVersion: "0.3", generationId: "generation-2" });

    await vi.waitFor(() => {
      expect(session.getState().staleSchemaIds["schema-a"]).toBe(false);
      expect(session.getState().staleSchemaIds["schema-b"]).toBe(true);
      expect(handshakes).toBeGreaterThanOrEqual(2);
    });

    session.setValue("schema-b", "amount", 6);
    expect(session.getState().notice).toBe("Runtime disconnected - controls are frozen.");

    session.dispose();
    deviceClient.close();
    panelClient.close();
  });
});
