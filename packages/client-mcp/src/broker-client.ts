import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  RIP_VERSION,
  SCENES_SCHEMA_ID,
  isValueControl,
  safeParseRIPMessage,
  validateControlValue,
  type InspectorControl,
  type PanelSchema,
  type RIPMessage,
  type RuntimeAnimationStarted,
  type SceneStatus
} from "@runtime-inspector/protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;
const ANIMATION_BUFFER_LIMIT = 300;

export interface BrokerClientOptions {
  url: string;
  token?: string;
  clientId?: string;
}

/** A scene published in the reserved `scenes` schema (RFC 0006). Same shape as panel-core's SceneEntry. */
export interface SceneEntry {
  id: string;
  title: string;
  group: string;
  description?: string;
  url?: string;
  active: boolean;
  reachable: boolean;
  stale: boolean;
}

export interface BrokerClient {
  connect(): Promise<void>;
  getSchemas(): PanelSchema[];
  getValues(schemaId: string): Record<string, unknown>;
  isStale(schemaId: string): boolean;
  setValue(schemaId: string, controlId: string, value: unknown): void;
  batchSet(schemaId: string, values: Record<string, unknown>): void;
  fireTrigger(schemaId: string, controlId: string): void;
  /** Scenes from the cached `scenes` schema, in group/control order. */
  getScenes(): SceneEntry[];
  /** Latest `scene.status` received for a scene, if any. */
  getSceneStatus(sceneId: string): SceneStatus | undefined;
  /** Subscribes to every incoming `scene.status`. Returns an unsubscribe function. */
  onSceneStatus(listener: (status: SceneStatus) => void): () => void;
  /**
   * Buffered `animation.started` messages whose call time
   * (`startedAtRuntimeMs - (startDelayMs ?? 0)`) is >= callTimeMs - 1.
   */
  getAnimationsSince(callTimeMs: number): RuntimeAnimationStarted[];
  close(): void;
}

export function createBrokerClient(options: BrokerClientOptions): BrokerClient {
  const clientId = options.clientId ?? `client-mcp-${randomUUID()}`;
  const schemas = new Map<string, PanelSchema>();
  const values = new Map<string, Record<string, unknown>>();
  const staleSchemaIds = new Set<string>();
  const sceneStatuses = new Map<string, SceneStatus>();
  const sceneListeners = new Set<(status: SceneStatus) => void>();
  const animations: RuntimeAnimationStarted[] = [];
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
    if (message.type === "scene.status") {
      sceneStatuses.set(message.sceneId, message);
      for (const listener of Array.from(sceneListeners)) {
        listener(message);
      }
      return;
    }

    if (message.type === "animation.started") {
      animations.push(message);
      if (animations.length > ANIMATION_BUFFER_LIMIT) {
        animations.splice(0, animations.length - ANIMATION_BUFFER_LIMIT);
      }
      return;
    }

    if (message.type === "schema.publish") {
      schemas.set(message.schema.id, message.schema);
      values.set(message.schema.id, collectInitialValues(message.schema));
      staleSchemaIds.delete(message.schema.id);
      return;
    }

    if (message.type === "schema.dispose") {
      schemas.delete(message.schemaId);
      values.delete(message.schemaId);
      staleSchemaIds.delete(message.schemaId);
      return;
    }

    if (message.type === "runtime.status" && message.schemaId) {
      if (message.online) {
        staleSchemaIds.delete(message.schemaId);
      } else if (schemas.has(message.schemaId)) {
        staleSchemaIds.add(message.schemaId);
      }
      return;
    }

    if (message.type === "control.patch") {
      const schemaValues = values.get(message.schemaId);
      if (!schemaValues) return;
      schemaValues[message.controlId] = message.value;
      return;
    }

    if (message.type === "control.commit") {
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

  function isStale(schemaId: string): boolean {
    return staleSchemaIds.has(schemaId);
  }

  function assertSchemaLive(schemaId: string): void {
    if (staleSchemaIds.has(schemaId)) {
      throw new Error(`Schema "${schemaId}" is stale because its runtime disconnected. Wait for it to reconnect before sending controls.`);
    }
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
    assertSchemaLive(schemaId);
    const result = validateControlValue(control, value);
    if (!result.ok) {
      throw new Error(
        `Invalid value for control "${controlId}": ${result.code}: ${result.message}`
      );
    }

    // An agent-driven value change is, by definition, a decided value rather
    // than an ephemeral preview - send it as a commit, not a patch.
    send({
      type: "control.commit",
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
    assertSchemaLive(schemaId);
    const entries = Object.entries(patchValues);
    for (const [controlId, value] of entries) {
      const control = findControl(schemaId, controlId);
      const result = validateControlValue(control, value);
      if (!result.ok) {
        throw new Error(
          `Invalid value for control "${controlId}": ${result.code}: ${result.message}`
        );
      }
    }

    const timestamp = Date.now();
    send({
      type: "control.batchPatch",
      schemaId,
      source: "panel",
      timestamp,
      patches: entries.map(([controlId, value]) => ({ controlId, value })),
      committed: true
    });

    const schemaValues = values.get(schemaId) ?? {};
    for (const [controlId, value] of entries) {
      schemaValues[controlId] = value;
    }
    values.set(schemaId, schemaValues);
  }

  function fireTrigger(schemaId: string, controlId: string) {
    const control = findControl(schemaId, controlId);
    assertSchemaLive(schemaId);
    if (control.kind !== "trigger") {
      throw new Error(`Control "${controlId}" is not a trigger (kind "${control.kind}").`);
    }

    send({
      type: "control.trigger",
      schemaId,
      controlId,
      source: "panel",
      timestamp: Date.now()
    });
  }

  function getScenes(): SceneEntry[] {
    const schema = schemas.get(SCENES_SCHEMA_ID);
    if (!schema) return [];
    const stale = staleSchemaIds.has(SCENES_SCHEMA_ID);
    const entries: SceneEntry[] = [];
    for (const group of schema.groups) {
      for (const control of group.controls) {
        if (control.kind !== "trigger" || !control.scene) continue;
        entries.push({
          id: control.id,
          title: control.label,
          group: group.label,
          ...(control.description !== undefined ? { description: control.description } : {}),
          ...(control.scene.url !== undefined ? { url: control.scene.url } : {}),
          active: control.scene.active,
          reachable: control.scene.reachable,
          stale
        });
      }
    }
    return entries;
  }

  function getSceneStatus(sceneId: string): SceneStatus | undefined {
    return sceneStatuses.get(sceneId);
  }

  function onSceneStatus(listener: (status: SceneStatus) => void): () => void {
    sceneListeners.add(listener);
    return () => {
      sceneListeners.delete(listener);
    };
  }

  function getAnimationsSince(callTimeMs: number): RuntimeAnimationStarted[] {
    return animations.filter(
      (animation) => animation.startedAtRuntimeMs - (animation.startDelayMs ?? 0) >= callTimeMs - 1
    );
  }

  function close() {
    socket?.close();
    socket = undefined;
  }

  return {
    connect,
    getSchemas,
    getValues,
    isStale,
    setValue,
    batchSet,
    fireTrigger,
    getScenes,
    getSceneStatus,
    onSceneStatus,
    getAnimationsSince,
    close
  };
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
