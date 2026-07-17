import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HandshakeAccept,
  parseRIPMessage,
  RIP_VERSION,
  type SchemaMessage,
  type RIPMessage,
  type RIPRole
} from "@runtime-inspector/protocol";

export interface BrokerOptions {
  port?: number;
  host?: string;
  token?: string;
}

interface ClientRecord {
  id: string;
  role?: RIPRole;
  socket: WebSocket;
}

export interface RuntimeInspectorBroker {
  brokerId: string;
  port: number;
  host: string;
  close(): Promise<void>;
}

export function startBroker(options: BrokerOptions = {}): RuntimeInspectorBroker {
  const port = options.port ?? Number(process.env.RUNTIME_INSPECTOR_PORT ?? 4577);
  const host = options.host ?? "127.0.0.1";
  const token = options.token;
  const brokerId = `broker-${randomUUID()}`;
  const server = new WebSocketServer({ host, port });
  const clients = new Map<WebSocket, ClientRecord>();
  const schemasByRuntime = new Map<string, SchemaMessage>();
  const onlineRuntimeIds = new Set<string>();

  server.on("connection", (socket) => {
    const record: ClientRecord = {
      id: `client-${randomUUID()}`,
      socket
    };
    clients.set(socket, record);

    socket.on("message", (data) => {
      let message: RIPMessage;

      try {
        message = parseRIPMessage(JSON.parse(data.toString()));
      } catch (error) {
        send(socket, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Message is not valid Runtime Inspector Protocol JSON.",
          cause: error instanceof Error ? error.message : error
        });
        return;
      }

      if (message.type === "handshake.hello") {
        if (message.protocolVersion !== RIP_VERSION) {
          send(socket, {
            type: "error",
            code: "VERSION_MISMATCH",
            message: `Protocol version mismatch: client sent "${message.protocolVersion}", broker expects "${RIP_VERSION}".`
          });
          socket.close();
          return;
        }

        if (
          token &&
          (message.role === "panel" || message.role === "workspace") &&
          message.token !== token
        ) {
          send(socket, {
            type: "error",
            code: "UNAUTHORIZED",
            message: `Missing or invalid ${message.role} token.`
          });
          socket.close();
          return;
        }

        record.role = message.role;
        record.id = message.clientId;
        const accept: HandshakeAccept = {
          type: "handshake.accept",
          protocolVersion: RIP_VERSION,
          brokerId,
          clientId: message.clientId
        };
        send(socket, accept);
        if (message.role === "panel") {
          replaySchemas(socket, schemasByRuntime, onlineRuntimeIds);
        }
        if (message.role === "runtime") {
          onlineRuntimeIds.add(record.id);
          broadcastRuntimeStatus(clients, record, true, schemasByRuntime.get(record.id)?.schema.id);
        }
        return;
      }

      if (message.type === "schema.publish" && record.role === "runtime") {
        schemasByRuntime.set(record.id, message);
      }

      if (message.type === "schema.dispose" && record.role === "runtime") {
        schemasByRuntime.delete(record.id);
      }

      routeMessage(clients, record, message);
    });

    socket.on("close", () => {
      clients.delete(socket);
      if (record.role === "runtime") {
        // Silent disconnect (no schema.dispose was sent): keep the cached
        // schema so late-joining panels can render it as stale, rather than
        // showing an empty screen during e.g. a Metro reload. The cache
        // entry is only dropped by an explicit schema.dispose message.
        onlineRuntimeIds.delete(record.id);
        broadcastRuntimeStatus(clients, record, false, schemasByRuntime.get(record.id)?.schema.id);
      }
    });
  });

  return {
    brokerId,
    get port() {
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    host,
    close: () =>
      new Promise((resolve, reject) => {
        for (const client of clients.values()) {
          client.socket.close();
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function replaySchemas(
  socket: WebSocket,
  schemasByRuntime: Map<string, SchemaMessage>,
  onlineRuntimeIds: Set<string>
) {
  for (const [runtimeId, schemaMessage] of schemasByRuntime.entries()) {
    send(socket, schemaMessage);
    if (!onlineRuntimeIds.has(runtimeId)) {
      // The publishing runtime is currently disconnected: follow the cached
      // schema.publish with its current runtime.status so the late-joining
      // panel can render the schema as stale rather than assuming it's live.
      send(socket, {
        type: "runtime.status",
        online: false,
        clientId: runtimeId,
        schemaId: schemaMessage.schema.id
      });
    }
  }
}

function broadcastRuntimeStatus(
  clients: Map<WebSocket, ClientRecord>,
  runtime: ClientRecord,
  online: boolean,
  schemaId?: string
) {
  for (const target of clients.values()) {
    if (target.role !== "panel") continue;
    send(target.socket, {
      type: "runtime.status",
      online,
      clientId: runtime.id,
      schemaId
    });
  }
}

/**
 * Routing table for messages that are not handled by an explicit special
 * case above (schema.publish/dispose caching, source.apply/applyResult):
 * every existing message type is bidirectional between `runtime` and
 * `panel` only — `workspace` clients never receive or send them. Mirrors
 * the routing/caching table in docs/protocol.md.
 */
function routeMessage(
  clients: Map<WebSocket, ClientRecord>,
  sender: ClientRecord,
  message: RIPMessage
) {
  if (message.type === "source.apply") {
    // panel -> workspace, at-most-once, never cached, never replayed.
    forwardToRole(clients, sender, message, "workspace");
    return;
  }

  if (message.type === "source.applyResult") {
    // workspace -> panel, at-most-once, never cached, never replayed.
    forwardToRole(clients, sender, message, "panel");
    return;
  }

  forwardToOppositeRole(clients, sender, message);
}

function forwardToOppositeRole(
  clients: Map<WebSocket, ClientRecord>,
  sender: ClientRecord,
  message: RIPMessage
) {
  if (sender.role !== "runtime" && sender.role !== "panel") return;
  for (const target of clients.values()) {
    if (target.socket === sender.socket) continue;
    if (target.role !== "runtime" && target.role !== "panel") continue;
    if (target.role === sender.role) continue;
    send(target.socket, message);
  }
}

function forwardToRole(
  clients: Map<WebSocket, ClientRecord>,
  sender: ClientRecord,
  message: RIPMessage,
  targetRole: RIPRole
) {
  for (const target of clients.values()) {
    if (target.socket === sender.socket) continue;
    if (target.role !== targetRole) continue;
    send(target.socket, message);
  }
}

function send(socket: WebSocket, message: RIPMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
