#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { execa } from "execa";
import qrcode from "qrcode-terminal";
import { startBroker } from "@runtime-inspector/transport-ws";

const command = process.argv[2];

if (command !== "dev") {
  console.log("Usage: runtime-inspector dev");
  process.exit(command ? 1 : 0);
}

const brokerPort = Number(process.env.RUNTIME_INSPECTOR_PORT ?? 4577);
const panelPort = Number(process.env.RUNTIME_INSPECTOR_PANEL_PORT ?? 4578);
const lanAddress = getLanAddress();
const broker = startBroker({ host: "0.0.0.0", port: brokerPort });
const cliDir = dirname(fileURLToPath(import.meta.url));
const panelDir = resolve(cliDir, "../../panel-web");
const localPanelUrl = `http://127.0.0.1:${panelPort}`;
const lanPanelUrl = lanAddress ? `http://${lanAddress}:${panelPort}` : undefined;
const localBrokerUrl = `ws://127.0.0.1:${broker.port}`;
const lanBrokerUrl = lanAddress ? `ws://${lanAddress}:${broker.port}` : localBrokerUrl;

console.log(`Runtime Inspector broker local: ${localBrokerUrl}`);
if (lanAddress) {
  console.log(`Runtime Inspector broker LAN:   ${lanBrokerUrl}`);
}
console.log(`Runtime Inspector panel local:  ${localPanelUrl}`);
if (lanPanelUrl) {
  console.log(`Runtime Inspector panel LAN:    ${lanPanelUrl}`);
  console.log(`React Native device env:        EXPO_PUBLIC_RI_BROKER_URL=${lanBrokerUrl}`);
  qrcode.generate(lanPanelUrl, { small: true });
}

const panel = execa("pnpm", ["dev"], {
  cwd: panelDir,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_RI_BROKER_URL: lanBrokerUrl,
    VITE_RI_PANEL_PORT: String(panelPort)
  }
});

const shutdown = async () => {
  panel.kill("SIGTERM");
  await broker.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await panel;

function getLanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4") continue;
      if (address.internal) continue;
      return address.address;
    }
  }

  return undefined;
}
