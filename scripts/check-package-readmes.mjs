#!/usr/bin/env node
/**
 * Validate every workspace package README and prove that public npm tarballs
 * actually include one. Run after the packages have been built.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagesDir = join(root, "packages");
const errors = [];
let publicCount = 0;
let totalCount = 0;

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = join(packagesDir, entry.name);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) continue;

  totalCount++;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const readmePath = join(packageDir, "README.md");

  if (!existsSync(readmePath) || !readFileSync(readmePath, "utf8").trim()) {
    errors.push(`${manifest.name}: packages/${entry.name}/README.md is missing or empty`);
    continue;
  }

  if (manifest.private === true) {
    console.log(`✓ ${manifest.name} (internal README)`);
    continue;
  }

  publicCount++;
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8"
  });
  if (pack.error || pack.status !== 0) {
    errors.push(`${manifest.name}: npm pack --dry-run failed: ${pack.error?.message ?? pack.stderr.trim()}`);
    continue;
  }

  try {
    const packages = JSON.parse(pack.stdout);
    const files = packages[0]?.files ?? [];
    if (!files.some((file) => file.path.toLowerCase() === "readme.md")) {
      errors.push(`${manifest.name}: README.md is not included in npm pack --dry-run`);
    } else {
      console.log(`✓ ${manifest.name} (README in npm tarball)`);
    }
  } catch (error) {
    errors.push(`${manifest.name}: unable to read npm pack JSON: ${error.message}`);
  }
}

if (errors.length) {
  console.error("\nPackage README validation failed:\n" + errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`\nValidated ${totalCount} workspace READMEs and ${publicCount} public npm tarballs.`);
}
