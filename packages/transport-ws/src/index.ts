import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HandshakeAccept,
  parseRIPMessage,
  RIP_VERSION,
  type RIPMessage,
  type RIPRole
} from "@runtime-inspector/protocol";

export interface BrokerOptions {
  port?: number;
  host?: string;
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
  const brokerId = `broker-${randomUUID()}`;
  const server = new WebSocketServer({ host, port });
  const clients = new Map<WebSocket, ClientRecord>();

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
        record.role = message.role;
        record.id = message.clientId;
        const accept: HandshakeAccept = {
          type: "handshake.accept",
          protocolVersion: RIP_VERSION,
          brokerId,
          clientId: message.clientId
        };
        send(socket, accept);
        return;
      }

      forwardToOppositeRole(clients, record, message);
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  return {
    brokerId,
    port,
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

function forwardToOppositeRole(
  clients: Map<WebSocket, ClientRecord>,
  sender: ClientRecord,
  message: RIPMessage
) {
  for (const target of clients.values()) {
    if (target.socket === sender.socket) continue;
    if (!sender.role || !target.role) continue;
    if (target.role === sender.role) continue;
    send(target.socket, message);
  }
}

function send(socket: WebSocket, message: RIPMessage) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
