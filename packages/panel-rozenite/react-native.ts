import { getRozeniteDevToolsClient } from "@rozenite/plugin-bridge";
import { registerRuntimeInspectorDeviceBridge } from "./src/device-bridge";
import {
  RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID,
  type RuntimeInspectorRozeniteEvents
} from "./src/shared";

declare const __DEV__: boolean | undefined;

type GlobalBridgeState = {
  dispose(): void;
};

const STATE_KEY = "__RUNTIME_INSPECTOR_ROZENITE_BRIDGE__";

if (isDev()) {
  void initialize();
}

async function initialize() {
  const globalState = globalThis as typeof globalThis & {
    [STATE_KEY]?: GlobalBridgeState;
  };

  globalState[STATE_KEY]?.dispose();

  const client = await getRozeniteDevToolsClient<RuntimeInspectorRozeniteEvents>(
    RUNTIME_INSPECTOR_ROZENITE_PLUGIN_ID
  );
  const bridge = registerRuntimeInspectorDeviceBridge(client);

  globalState[STATE_KEY] = {
    dispose() {
      bridge.dispose();
      client.close();
      if (globalState[STATE_KEY] === this) {
        delete globalState[STATE_KEY];
      }
    }
  };
}

function isDev() {
  return typeof __DEV__ === "undefined" ? process.env.NODE_ENV !== "production" : __DEV__;
}
