#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { startBroker } from "@runtime-inspector/transport-ws";

const command = process.argv[2];

if (command !== "dev") {
  console.log("Usage: runtime-inspector dev");
  process.exit(command ? 1 : 0);
}

const broker = startBroker({ port: Number(process.env.RUNTIME_INSPECTOR_PORT ?? 4577) });
const cliDir = dirname(fileURLToPath(import.meta.url));
const panelDir = resolve(cliDir, "../../panel-web");

console.log(`Runtime Inspector broker: ws://${broker.host}:${broker.port}`);
console.log("Runtime Inspector panel: http://127.0.0.1:4578");

const panel = execa("pnpm", ["dev"], {
  cwd: panelDir,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_RI_BROKER_URL: `ws://${broker.host}:${broker.port}`
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
