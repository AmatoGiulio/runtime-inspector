// Copies the prebuilt web panel into dist/panel so the published CLI can serve
// it without panel-web's sources or Vite (see src/panel-server.ts).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(cliRoot, "../panel-web/dist");
const target = resolve(cliRoot, "dist/panel");

if (!existsSync(resolve(source, "index.html"))) {
  console.error(`copy-panel: ${source}/index.html is missing; build @runtime-inspector/panel-web first.`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`copy-panel: ${source} -> ${target}`);
