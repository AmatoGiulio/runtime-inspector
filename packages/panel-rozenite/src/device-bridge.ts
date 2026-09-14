import type { RozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import { RIP_VERSION, safeParseRIPMessage } from "@runtime-inspector/protocol";
import { attachRuntimeInspectorProtocolClient } from "@runtime-inspector/react-native";
import {
  RIP_EVENT,
  RUNTIME_READY_EVENT,
  type RuntimeInspectorRozeniteEvents
} from "./shared";

export interface DeviceBridgeOptions {
  generationId?: string;
}

export function registerRuntimeInspectorDeviceBridge(
  client: RozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>,
  options: DeviceBridgeOptions = {}
) {
  const runtimeClient = attachRuntimeInspectorProtocolClient({
    send(message) {
      client.send(RIP_EVENT, { message });
    }
  });

  const ripSubscription = client.onMessage(RIP_EVENT, ({ message }) => {
    const parsed = safeParseRIPMessage(message);
    if (parsed) {
      runtimeClient.receive(parsed);
    }
  });

  client.send(RUNTIME_READY_EVENT, {
    protocolVersion: RIP_VERSION,
    generationId: options.generationId ?? createGenerationId()
  });

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      ripSubscription.remove();
      runtimeClient.dispose();
    }
  };
}

function createGenerationId() {
  return `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
