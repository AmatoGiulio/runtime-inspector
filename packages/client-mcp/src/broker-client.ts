import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  RIP_VERSION,
  isValidControlValue,
  isValueControl,
  safeParseRIPMessage,
  type InspectorControl,
  type PanelSchema,
  type RIPMessage
} from "@runtime-inspector/protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;

export interface BrokerClientOptions {
  url: string;
  token?: string;
  clientId?: string;
}

export interface BrokerClient {
  connect(): Promise<void>;
  getSchemas(): PanelSchema[];
  getValues(schemaId: string): Record<string, unknown>;
  setValue(schemaId: string, controlId: string, value: unknown): void;
  batchSet(schemaId: string, values: Record<string, unknown>): void;
  fireTrigger(schemaId: string, controlId: string): void;
  close(): void;
}

export function createBrokerClient(options: BrokerClientOptions): BrokerClient {
  const clientId = options.clientId ?? `client-mcp-${randomUUID()}`;
  const schemas = new Map<string, PanelSchema>();
  const values = new Map<string, Record<string, unknown>>();
  let socket: WebSocket | undefined;

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(options.url);
      socket = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`Timed out connecting to broker at ${options.url}.`));
      }, HANDSHAKE_TIMEOUT_MS);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "handshake.hello",
            protocolVersion: RIP_VERSION,
            role: "panel",
            clientId,
            clientName: "Runtime Inspector MCP Client",
            token: options.token
          })
        );
      });

      ws.on("message", (data) => {
        const message = safeParseRIPMessage(data);
        if (!message) return;

        if (!settled) {
          if (message.type === "handshake.accept") {
            settled = true;
            clearTimeout(timer);
            resolve();
          } else if (message.type === "error") {
            settled = true;
            clearTimeout(timer);
            reject(new Error(`${message.code}: ${message.message}`));
            ws.close();
            return;
          }
        }

        handleMessage(message);
      });

      ws.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Broker closed the connection before accepting the handshake."));
      });
    });
  }

  function handleMessage(message: RIPMessage) {
    if (message.type === "schema.publish") {
      schemas.set(message.schema.id, message.schema);
      values.set(message.schema.id, collectInitialValues(message.schema));
      return;
    }

    if (message.type === "control.patch") {
      const schemaValues = values.get(message.schemaId);
      if (!schemaValues) return;
      schemaValues[message.controlId] = message.value;
      return;
    }

    if (message.type === "control.batchPatch") {
      const schemaValues = values.get(message.schemaId);
      if (!schemaValues) return;
      for (const patch of message.patches) {
        schemaValues[patch.controlId] = patch.value;
      }
    }
  }

  function getSchemas(): PanelSchema[] {
    return Array.from(schemas.values());
  }

  function getValues(schemaId: string): Record<string, unknown> {
    return { ...(values.get(schemaId) ?? {}) };
  }

  function findControl(schemaId: string, controlId: string): InspectorControl {
    const schema = schemas.get(schemaId);
    if (!schema) {
      throw new Error(`Unknown schema "${schemaId}". Call get_schema first.`);
    }
    const control = schema.groups
      .flatMap((group) => group.controls)
      .find((candidate) => candidate.id === controlId);
    if (!control) {
      throw new Error(`Unknown control "${controlId}" in schema "${schemaId}".`);
    }
    return control;
  }

  function send(message: RIPMessage) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to broker. Call connect() first.");
    }
    socket.send(JSON.stringify(message));
  }

  function setValue(schemaId: string, controlId: string, value: unknown) {
    const control = findControl(schemaId, controlId);
    if (!isValidControlValue(control, value)) {
      throw new Error(
        `Invalid value for control "${controlId}" (kind "${control.kind}"): ${JSON.stringify(value)}`
      );
    }

    send({
      type: "control.patch",
      schemaId,
      controlId,
      value,
      source: "panel",
      timestamp: Date.now()
    });

    if (isValueControl(control)) {
      const schemaValues = values.get(schemaId) ?? {};
      schemaValues[controlId] = value;
      values.set(schemaId, schemaValues);
    }
  }

  function batchSet(schemaId: string, patchValues: Record<string, unknown>) {
    const entries = Object.entries(patchValues);
    for (const [controlId, value] of entries) {
      const control = findControl(schemaId, controlId);
      if (!isValidControlValue(control, value)) {
        throw new Error(
          `Invalid value for control "${controlId}" (kind "${control.kind}"): ${JSON.stringify(value)}`
        );
      }
    }

    const timestamp = Date.now();
    send({
      type: "control.batchPatch",
      schemaId,
      source: "panel",
      timestamp,
      patches: entries.map(([controlId, value]) => ({ controlId, value }))
    });

    const schemaValues = values.get(schemaId) ?? {};
    for (const [controlId, value] of entries) {
      schemaValues[controlId] = value;
    }
    values.set(schemaId, schemaValues);
  }

  function fireTrigger(schemaId: string, controlId: string) {
    const control = findControl(schemaId, controlId);
    if (control.kind !== "trigger") {
      throw new Error(`Control "${controlId}" is not a trigger (kind "${control.kind}").`);
    }

    send({
      type: "control.patch",
      schemaId,
      controlId,
      value: Date.now(),
      source: "panel",
      timestamp: Date.now()
    });
  }

  function close() {
    socket?.close();
    socket = undefined;
  }

  return { connect, getSchemas, getValues, setValue, batchSet, fireTrigger, close };
}

function collectInitialValues(schema: PanelSchema): Record<string, unknown> {
  return Object.fromEntries(
    schema.groups.flatMap((group) =>
      group.controls
        .filter(isValueControl)
        .map((control) => [control.id, control.value ?? control.defaultValue])
    )
  );
}
