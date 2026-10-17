#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  SCENES_SCHEMA_ID,
  isValueControl,
  type PanelSchema,
  type SceneStatus
} from "@runtime-inspector/protocol";
import { createBrokerClient, type BrokerClient } from "./broker-client.js";
import { resolveBrokerTarget } from "./session-file.js";

export {
  createBrokerClient,
  type BrokerClient,
  type BrokerClientOptions,
  type SceneEntry
} from "./broker-client.js";

/** How long a fresh connection waits for the broker's schema replay before answering. */
const SCHEMA_REPLAY_WAIT_MS = 500;

let client: BrokerClient | undefined;
let connecting: Promise<BrokerClient> | undefined;

async function getConnectedClient(): Promise<BrokerClient> {
  if (client && client.isConnected()) return client;
  if (client) {
    // The broker went away (e.g. `runtime-inspector dev` restarted): drop the
    // dead client so the next attempt re-resolves the target.
    client.close();
    client = undefined;
  }
  if (!connecting) {
    // Resolved on every new connection attempt: env first, else the session
    // file written by `runtime-inspector dev` (a restarted CLI is picked up).
    const target = resolveBrokerTarget();
    const created = createBrokerClient({ url: target.url, token: target.token });
    connecting = created
      .connect()
      .then(() => created.waitForSchemas(SCHEMA_REPLAY_WAIT_MS))
      .then(() => {
        client = created;
        return created;
      })
      .finally(() => {
        connecting = undefined;
      });
  }
  return connecting;
}

function resolveSchemaId(activeClient: BrokerClient, schemaId: string | undefined): string {
  const schemas = activeClient.getSchemas();
  if (schemaId) return schemaId;
  if (schemas.length === 1) return schemas[0]!.id;
  if (schemas.length === 0) {
    throw new Error("No runtime schema has been published yet. Start the app's runtime and try again.");
  }
  throw new Error(
    `schemaId is required: multiple schemas are cached (${schemas.map((schema) => schema.id).join(", ")}).`
  );
}

function schemaWithValues(activeClient: BrokerClient, schema: PanelSchema) {
  const values = activeClient.getValues(schema.id);
  return {
    ...schema,
    stale: activeClient.isStale(schema.id),
    groups: schema.groups.map((group) => ({
      ...group,
      controls: group.controls.map((control) => ({
        ...control,
        currentValue: isValueControl(control) ? values[control.id] ?? control.defaultValue : undefined
      }))
    }))
  };
}

const server = new McpServer({
  name: "runtime-inspector-mcp",
  version: "0.1.0"
});

server.registerTool(
  "get_schema",
  {
    title: "Get Runtime Inspector schema",
    description:
      "Read the control schema(s) published by the running app's runtime, merged with current values. " +
      "Always call this first before tuning: it tells you which controls (sliders, toggles, colors, " +
      "bezier curves, springs, triggers) are available, their ids, ranges, and current values. " +
      "Returns a message if no runtime has published a schema yet.",
    inputSchema: {}
  },
  async () => {
    try {
      const activeClient = await getConnectedClient();
      const schemas = activeClient.getSchemas();
      if (schemas.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No runtime schema has been published yet. Start the app's runtime and try again."
            }
          ]
        };
      }
      const payload = schemas.map((schema) => schemaWithValues(activeClient, schema));
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "set_control_value",
  {
    title: "Set a control value",
    description:
      "Set a single control's value on the running app (e.g. tweak a spring's damping, a slider, a color). " +
      "Call get_schema first to see valid control ids and ranges. After setting values, consider calling " +
      "trigger on a replay control to observe the effect. schemaId is optional if exactly one schema is cached.",
    inputSchema: {
      schemaId: z.string().optional().describe("Schema id. Optional if only one schema is cached."),
      controlId: z.string().describe("The control id to update."),
      value: z.unknown().describe("The new value, matching the control's kind (number, boolean, string, etc).")
    }
  },
  async ({ schemaId, controlId, value }) => {
    try {
      const activeClient = await getConnectedClient();
      const resolvedSchemaId = resolveSchemaId(activeClient, schemaId);
      activeClient.setValue(resolvedSchemaId, controlId, value);
      return {
        content: [
          {
            type: "text",
            text: `Set ${controlId} = ${JSON.stringify(value)} on schema "${resolvedSchemaId}".`
          }
        ]
      };
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "batch_set",
  {
    title: "Batch set control values",
    description:
      "Set multiple control values at once, atomically (all values are validated before anything is sent). " +
      "Useful for applying a whole tuned preset in one step before firing a replay trigger to observe it.",
    inputSchema: {
      schemaId: z.string().optional().describe("Schema id. Optional if only one schema is cached."),
      values: z.record(z.unknown()).describe("Map of controlId to new value.")
    }
  },
  async ({ schemaId, values }) => {
    try {
      const activeClient = await getConnectedClient();
      const resolvedSchemaId = resolveSchemaId(activeClient, schemaId);
      activeClient.batchSet(resolvedSchemaId, values);
      return {
        content: [
          {
            type: "text",
            text: `Applied ${Object.keys(values).length} value(s) on schema "${resolvedSchemaId}": ${JSON.stringify(values)}.`
          }
        ]
      };
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "trigger",
  {
    title: "Fire a trigger control",
    description:
      "Fire a trigger control (e.g. \"replay transition\") to re-run an animation on the device after " +
      "changing values, so you can observe the effect of your tuning without touching the app. " +
      "Scenes are triggers in the \"scenes\" schema, but prefer open_scene: it navigates, waits for the " +
      "motion to play and reports what ran.",
    inputSchema: {
      schemaId: z.string().optional().describe("Schema id. Optional if only one schema is cached."),
      controlId: z.string().describe("The trigger control id to fire.")
    }
  },
  async ({ schemaId, controlId }) => {
    try {
      const activeClient = await getConnectedClient();
      const resolvedSchemaId = resolveSchemaId(activeClient, schemaId);
      activeClient.fireTrigger(resolvedSchemaId, controlId);
      return {
        content: [{ type: "text", text: `Fired trigger "${controlId}" on schema "${resolvedSchemaId}".` }]
      };
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  "list_scenes",
  {
    title: "List motion scenes",
    description:
      "List the app's motion scenes (named moments such as a product reveal or a sheet opening). " +
      "Each can be opened with open_scene: the app navigates there and plays the motion.",
    inputSchema: {}
  },
  async () => {
    try {
      const activeClient = await getConnectedClient();
      const scenes = activeClient.getScenes();
      if (scenes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "The app publishes no scenes. Declare them with defineScene/useScene in the app's " +
                "Runtime Inspector SDK and make sure the app is running."
            }
          ]
        };
      }
      const payload = scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        group: scene.group,
        ...(scene.description !== undefined ? { description: scene.description } : {}),
        url: scene.url,
        active: scene.active,
        reachable: scene.reachable,
        stale: scene.stale
      }));
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      return errorResult(error);
    }
  }
);

const OPEN_SCENE_CAP_MS = 8000;

server.registerTool(
  "open_scene",
  {
    title: "Open a motion scene",
    description:
      "Open a motion scene: the app navigates to it, waits until the screen is mounted and plays the " +
      "motion. Returns the animations that started in the moment after the scene played (target, kind, " +
      "start/call time relative to the play, duration, config, the controls that tune them, source). " +
      "Tune them with set_control_value/batch_set on the referenced controls; committing then " +
      "re-opening the scene replays it with the new values. Call list_scenes first for valid ids.",
    inputSchema: {
      sceneId: z.string().describe("The scene id from list_scenes."),
      observeMs: z
        .number()
        .min(0)
        .max(5000)
        .optional()
        .describe("How long to keep observing animations after the scene plays, in ms. Default 1500.")
    }
  },
  async ({ sceneId, observeMs }) => {
    try {
      const activeClient = await getConnectedClient();
      const scene = activeClient.getScenes().find((entry) => entry.id === sceneId);
      if (!scene) {
        throw new Error(`Unknown scene "${sceneId}". Call list_scenes to see the available scenes.`);
      }

      // Subscribe before firing so only statuses received after the request count.
      let resolveOutcome!: (status: SceneStatus | undefined) => void;
      const outcome = new Promise<SceneStatus | undefined>((resolve) => {
        resolveOutcome = resolve;
      });
      let lastPhase: string | undefined;
      const unsubscribe = activeClient.onSceneStatus((status) => {
        if (status.sceneId !== sceneId) return;
        lastPhase = status.phase;
        if (status.phase === "playing" || status.phase === "failed") {
          resolveOutcome(status);
        }
      });
      const cap = setTimeout(() => resolveOutcome(undefined), OPEN_SCENE_CAP_MS);

      let status: SceneStatus | undefined;
      try {
        activeClient.fireTrigger(SCENES_SCHEMA_ID, sceneId);
        status = await outcome;
      } finally {
        clearTimeout(cap);
        unsubscribe();
      }

      if (!status) {
        return errorResult(
          new Error(
            `Scene "${sceneId}" did not start playing within ${OPEN_SCENE_CAP_MS} ms` +
              (lastPhase ? ` (last phase: ${lastPhase}).` : " (the app sent no status; is it running a Runtime Inspector version with scenes?).")
          )
        );
      }
      if (status.phase === "failed") {
        return errorResult(new Error(`Scene "${sceneId}" failed: ${status.code}: ${status.reason}`));
      }

      const playedAt = status.atRuntimeMs;
      await new Promise((resolve) => setTimeout(resolve, observeMs ?? 1500));

      const animations = activeClient
        .getAnimationsSince(playedAt)
        .map((animation) => {
          const callTime = animation.startedAtRuntimeMs - (animation.startDelayMs ?? 0);
          return {
            target: animation.target,
            kind: animation.animationKind,
            startMs: Math.round(animation.startedAtRuntimeMs - playedAt),
            callMs: Math.round(callTime - playedAt),
            durationMs: typeof animation.config.duration === "number" ? animation.config.duration : null,
            config: animation.config,
            parameterControls: animation.parameterControls,
            startControl: animation.startControl,
            source: animation.source ? `${animation.source.file}:${animation.source.line}` : undefined
          };
        })
        .sort((a, b) => a.startMs - b.startMs);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ scene: sceneId, playedAtRuntimeMs: playedAt, animations }, null, 2)
          }
        ]
      };
    } catch (error) {
      return errorResult(error);
    }
  }
);

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
