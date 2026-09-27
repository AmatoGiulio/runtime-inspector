import type { RozeniteDevToolsClient, Subscription } from "@rozenite/plugin-bridge";
import type { WebSocketLike } from "@runtime-inspector/panel-core";
import { RIP_VERSION, safeParseRIPMessage, type RIPMessage } from "@runtime-inspector/protocol";
import {
  RIP_EVENT,
  RUNTIME_READY_EVENT,
  type RuntimeInspectorRozeniteEvents
} from "./shared";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class RozenitePanelSocket implements WebSocketLike {
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  private readonly subscriptions: Subscription[] = [];
  private readonly schemaIds = new Set<string>();
  private generationId: string | undefined;
  private handshake: RIPMessage | undefined;

  constructor(private readonly client: RozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>) {
    this.subscriptions.push(
      client.onMessage(RIP_EVENT, ({ message }) => this.handleRipMessage(message)),
      client.onMessage(RUNTIME_READY_EVENT, (payload) => this.handleRuntimeReady(payload))
    );

    queueMicrotask(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    if (this.readyState !== OPEN) return;
    const message = safeParseRIPMessage(data);
    if (!message) {
      this.onerror?.();
      return;
    }
    if (message.type === "handshake.hello") {
      this.handshake = message;
    }
    this.client.send(RIP_EVENT, { message });
  }

  close() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions.length = 0;
    this.onclose?.();
  }

  private handleRipMessage(message: RIPMessage) {
    if (message.type === "schema.publish") {
      this.schemaIds.add(message.schema.id);
    } else if (message.type === "schema.dispose") {
      this.schemaIds.delete(message.schemaId);
    }
    this.emit(message);
  }

  private handleRuntimeReady(payload: RuntimeInspectorRozeniteEvents[typeof RUNTIME_READY_EVENT]) {
    if (payload.protocolVersion !== RIP_VERSION) {
      this.emit({
        type: "error",
        code: "VERSION_MISMATCH",
        message: `Rozenite runtime uses protocol ${payload.protocolVersion}; panel expects ${RIP_VERSION}.`
      });
      return;
    }

    if (this.generationId && this.generationId !== payload.generationId) {
      for (const schemaId of this.schemaIds) {
        this.emit({
          type: "runtime.status",
          online: false,
          clientId: "rozenite-runtime",
          schemaId
        });
      }
      if (this.handshake) {
        this.client.send(RIP_EVENT, { message: this.handshake });
      }
    }

    this.generationId = payload.generationId;
  }

  private emit(message: RIPMessage) {
    if (this.readyState === CLOSED) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

export function createRozenitePanelSocket(
  client: RozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>
): WebSocketLike {
  return new RozenitePanelSocket(client);
}
