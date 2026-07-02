#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isValueControl, type PanelSchema } from "@runtime-inspector/protocol";
import { createBrokerClient, type BrokerClient } from "./broker-client.js";

export { createBrokerClient, type BrokerClient, type BrokerClientOptions } from "./broker-client.js";

const brokerUrl = process.env.RI_BROKER_URL ?? "ws://127.0.0.1:4577";
const token = process.env.RI_TOKEN;

let client: BrokerClient | undefined;
let connecting: Promise<BrokerClient> | undefined;

async function getConnectedClient(): Promise<BrokerClient> {
  if (client) return client;
  if (!connecting) {
    const created = createBrokerClient({ url: brokerUrl, token });
    connecting = created
      .connect()
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
      "changing values, so you can observe the effect of your tuning without touching the app.",
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

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const transport = new StdioServerTransport();
await server.connect(transport);
