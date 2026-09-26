import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import {
  RIP_VERSION,
  safeParseRIPMessage,
  type SourceApplyResult
} from "@runtime-inspector/protocol";
import { applySourceRequests } from "./source-apply.js";

const RECONNECT_DELAY_MS = 1000;

export interface WorkspaceClientOptions {
  brokerUrl: string;
  token?: string;
  rootDir: string;
  clientId?: string;
  log?(message: string): void;
}

export interface WorkspaceClient {
  close(): void;
}

/**
 * Connects to the local broker as a `workspace`-role client (RFC 0004, Part
 * 3): receives `source.apply` commands from panels and writes the tuned
 * values back into source via `applySourceRequests`, replying with
 * `source.applyResult`. In `runtime-inspector dev` this runs in-process
 * alongside the broker it connects to, so the reconnect loop below is pure
 * resilience (e.g. a broker restart), not a real network dependency.
 */
export function startWorkspaceClient(options: WorkspaceClientOptions): WorkspaceClient {
  const clientId = options.clientId ?? `workspace-${randomUUID()}`;
  const log = options.log ?? (() => {});
  let socket: WebSocket | undefined;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | undefined;

  function connect(): void {
    if (closed) return;

    const ws = new WebSocket(options.brokerUrl);
    socket = ws;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "handshake.hello",
          protocolVersion: RIP_VERSION,
          role: "workspace",
          clientId,
          clientName: "Runtime Inspector Workspace",
          token: options.token
        })
      );
    });

    ws.on("message", (data) => {
      void handleMessage(data);
    });

    ws.on("close", () => {
      if (closed) return;
      scheduleReconnect();
    });

    ws.on("error", () => {
      // Surface via the close event's reconnect loop; nothing to add here.
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    reconnectTimer.unref?.();
  }

  async function handleMessage(data: unknown): Promise<void> {
    const message = safeParseRIPMessage(data);
    if (!message || message.type !== "source.apply") return;

    const results = await applySourceRequests(message.requests, {
      rootDir: options.rootDir,
      readFile: (path) => readFile(path, "utf-8"),
      writeFile: (path, content) => writeFile(path, content, "utf-8")
    });

    for (const result of results) {
      if (result.ok) {
        log(`source.apply ${result.controlId}: ok (${result.previous} -> ${result.written})`);
      } else {
        const detail = result.message ? ` (${result.message})` : "";
        log(`source.apply ${result.controlId}: ${result.code}${detail}`);
      }
    }

    const response: SourceApplyResult = {
      type: "source.applyResult",
      schemaId: message.schemaId,
      results
    };

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response));
    }
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}
