#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { execa } from "execa";
import qrcode from "qrcode-terminal";
import { startBroker } from "@runtime-inspector/transport-ws";
import { startWorkspaceClient } from "./workspace.js";
import { removeSessionFile, writeSessionFile } from "./session-file.js";
import { createSessionToken } from "./session-token.js";
import { runInitCommand } from "./init.js";
import { hasBundledPanel, startPanelServer } from "./panel-server.js";

const USAGE = [
  "Usage:",
  "  runtime-inspector dev                             Start the broker, panel and source write-back",
  "  runtime-inspector init [--cwd <dir>] [--dry-run]  Wire a React Native app for Runtime Inspector"
].join("\n");

const command = process.argv[2];

if (command === "init") {
  process.exit(await runInitCommand(process.argv.slice(3)));
}

if (command !== "dev") {
  console.log(USAGE);
  process.exit(command && command !== "--help" && command !== "-h" ? 1 : 0);
}

const requestedBrokerPort = Number(process.env.RUNTIME_INSPECTOR_PORT ?? 4577);
const requestedPanelPort = Number(process.env.RUNTIME_INSPECTOR_PANEL_PORT ?? 4600);
const brokerPort = await findAvailablePort(requestedBrokerPort);
const panelPort = await findAvailablePort(requestedPanelPort, [brokerPort]);
const lanAddress = getLanAddress();
const token = createSessionToken();
const broker = startBroker({ host: "0.0.0.0", port: brokerPort, token });
const cliDir = dirname(fileURLToPath(import.meta.url));
// Installed package: dist/panel holds the prebuilt web panel. In this monorepo
// (`pnpm dev` runs src/ through tsx) the panel runs from source with Vite.
const bundledPanelDir = resolve(cliDir, "panel");
const panelSourceDir = resolve(cliDir, "../../panel-web");
const localBrokerUrl = `ws://127.0.0.1:${broker.port}`;
const lanBrokerUrl = lanAddress ? `ws://${lanAddress}:${broker.port}` : localBrokerUrl;
const panelQuery = (brokerUrl: string) => `?token=${token}&broker=${encodeURIComponent(brokerUrl)}`;
const localPanelUrl = `http://127.0.0.1:${panelPort}/${panelQuery(localBrokerUrl)}`;
const lanPanelUrl = lanAddress ? `http://${lanAddress}:${panelPort}/${panelQuery(lanBrokerUrl)}` : undefined;

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
  qrcode.generate(lanPanelUrl, { small: true });
}
console.log(`MCP agent client:              RI_BROKER_URL=${localBrokerUrl} RI_TOKEN=${token} runtime-inspector-mcp`);

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
// The DevTools panel is not published to npm yet; mention it only where it is installed.
if (resolvesFrom(workspaceRoot, "@runtime-inspector/panel-rozenite/package.json")) {
  console.log(`React Native DevTools:         open the "Runtime Inspector" tab (Rozenite, no broker needed)`);
}

const sessionPath = writeSessionFile({
  version: 1,
  brokerUrl: localBrokerUrl,
  ...(lanAddress ? { lanBrokerUrl } : {}),
  token,
  panelUrl: localPanelUrl,
  workspaceRoot,
  pid: process.pid,
  startedAt: new Date().toISOString()
});
console.log(`Session file: ${sessionPath} (Workbench and MCP read it; no token to copy)`);

const panelServer = hasBundledPanel(bundledPanelDir)
  ? await startPanelServer({ rootDir: bundledPanelDir, host: "0.0.0.0", port: panelPort })
  : undefined;
const panel = panelServer
  ? undefined
  : execa("pnpm", ["dev"], {
      cwd: panelSourceDir,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_RI_BROKER_URL: lanBrokerUrl,
        VITE_RI_PANEL_PORT: String(panelPort)
      }
    });

const shutdown = async () => {
  removeSessionFile(process.pid);
  panel?.kill("SIGTERM");
  panelServer?.close();
  workspace.close();
  await broker.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (panel) await panel;

function resolvesFrom(root: string, request: string) {
  try {
    createRequire(join(root, "package.json")).resolve(request);
    return true;
  } catch {
    return false;
  }
}

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
