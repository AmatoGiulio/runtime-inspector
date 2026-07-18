#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { execa } from "execa";
import qrcode from "qrcode-terminal";
import { startBroker } from "@runtime-inspector/transport-ws";
import { startWorkspaceClient } from "./workspace.js";

const command = process.argv[2];

if (command !== "dev") {
  console.log("Usage: runtime-inspector dev");
  process.exit(command ? 1 : 0);
}

const requestedBrokerPort = Number(process.env.RUNTIME_INSPECTOR_PORT ?? 4577);
const requestedPanelPort = Number(process.env.RUNTIME_INSPECTOR_PANEL_PORT ?? 4600);
const brokerPort = await findAvailablePort(requestedBrokerPort);
const panelPort = await findAvailablePort(requestedPanelPort, [brokerPort]);
const lanAddress = getLanAddress();
const token = randomBytes(4).toString("hex");
const broker = startBroker({ host: "0.0.0.0", port: brokerPort, token });
const cliDir = dirname(fileURLToPath(import.meta.url));
const panelDir = resolve(cliDir, "../../panel-web");
const localPanelUrl = `http://127.0.0.1:${panelPort}?token=${token}`;
const lanPanelUrl = lanAddress ? `http://${lanAddress}:${panelPort}?token=${token}` : undefined;
const localBrokerUrl = `ws://127.0.0.1:${broker.port}`;
const lanBrokerUrl = lanAddress ? `ws://${lanAddress}:${broker.port}` : localBrokerUrl;

if (brokerPort !== requestedBrokerPort) {
  console.log(`Runtime Inspector broker port ${requestedBrokerPort} busy; using ${brokerPort}.`);
}
if (panelPort !== requestedPanelPort) {
  console.log(`Runtime Inspector panel port ${requestedPanelPort} busy; using ${panelPort}.`);
}
console.log(`Runtime Inspector broker local: ${localBrokerUrl}`);
if (lanAddress) {
  console.log(`Runtime Inspector broker LAN:   ${lanBrokerUrl}`);
}
console.log(`Runtime Inspector panel local:  ${localPanelUrl}`);
if (lanPanelUrl) {
  console.log(`Runtime Inspector panel LAN:    ${lanPanelUrl}`);
  console.log(`React Native devices auto-discover the broker via Metro (zero config).`);
  console.log(`Override if needed:            EXPO_PUBLIC_RI_BROKER_URL=${lanBrokerUrl}`);
  qrcode.generate(lanPanelUrl, { small: true });
}
console.log(`MCP agent client:              RI_BROKER_URL=${localBrokerUrl} RI_TOKEN=${token} runtime-inspector-mcp`);
console.log(`Runtime Inspector DevTools:    rozenite panel -> broker ${localBrokerUrl}, token ${token}`);

// Source anchors are relative to the app's Babel root, so write-back must
// resolve them against the app project root — the CLI's cwd by default, or
// RUNTIME_INSPECTOR_WORKSPACE_ROOT when the CLI runs from elsewhere (e.g.
// this monorepo's root `dev` script, whose cwd is packages/cli).
const workspaceRoot = process.env.RUNTIME_INSPECTOR_WORKSPACE_ROOT
  ? resolve(process.cwd(), process.env.RUNTIME_INSPECTOR_WORKSPACE_ROOT)
  : process.cwd();
const workspace = startWorkspaceClient({
  brokerUrl: localBrokerUrl,
  token,
  rootDir: workspaceRoot,
  log: (message) => console.log(`Runtime Inspector workspace: ${message}`)
});
console.log(`Runtime Inspector workspace: write-back enabled (${workspaceRoot})`);

const panel = execa("pnpm", ["dev"], {
  cwd: panelDir,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_RI_BROKER_URL: lanBrokerUrl,
    VITE_RI_PANEL_PORT: String(panelPort),
    VITE_RI_TOKEN: token
  }
});

const shutdown = async () => {
  panel.kill("SIGTERM");
  workspace.close();
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

async function findAvailablePort(startPort: number, skip: number[] = []) {
  for (let port = startPort; port < startPort + 20; port += 1) {
    if (skip.includes(port)) continue;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available port found from ${startPort} to ${startPort + 19}.`);
}

function isPortAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}
