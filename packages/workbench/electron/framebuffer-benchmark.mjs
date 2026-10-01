import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "simulator-framebuffer.m");
const buildDir = path.join(os.tmpdir(), "runtime-inspector");
const binary = path.join(buildDir, "simulator-framebuffer-benchmark");

const PROFILES = [
  { name: "baseline", width: 600, quality: 0.65 },
  { name: "balanced", width: 560, quality: 0.60 },
  { name: "fast", width: 520, quality: 0.58 },
  { name: "lean", width: 480, quality: 0.55 }
];

const rounds = integerArg("--rounds", 3);
const warmup = integerArg("--warmup", 12);
const iterations = integerArg("--iterations", 80);
const sourceWidth = integerArg("--source-width", 1320);
const sourceHeight = integerArg("--source-height", 2868);
const gateProfile = stringArg("--gate-profile");
const maxRelativeP95 = numberArg("--max-relative-p95", 0.9);
const maxRelativeBytes = numberArg("--max-relative-bytes", 1.0);
const minPsnrDb = numberArg("--min-psnr-db");

if (process.platform !== "darwin") {
  console.error("Framebuffer benchmark requires macOS.");
  process.exit(2);
}

await mkdir(buildDir, { recursive: true });
await compile();

const aggregate = [];
for (const profile of PROFILES) {
  const runs = [];
  for (let round = 0; round < rounds; round += 1) {
    runs.push(await runProfile(profile));
  }

  aggregate.push({
    ...profile,
    rounds,
    p50Ms: median(runs.map((run) => run.p50Ms)),
    p95Ms: median(runs.map((run) => run.p95Ms)),
    avgMs: median(runs.map((run) => run.avgMs)),
    avgBytes: median(runs.map((run) => run.avgBytes)),
    capacityFpsP95: median(runs.map((run) => run.capacityFpsP95)),
    psnrDb: median(runs.map((run) => run.psnrDb)),
    outputHeight: runs[0].outputHeight
  });
}

const baseline = aggregate.find((item) => item.name === "baseline");
for (const item of aggregate) {
  item.relativeP95 = item.p95Ms / baseline.p95Ms;
  item.relativeBytes = item.avgBytes / baseline.avgBytes;
}

printTable(aggregate);

console.log("\nJSON");
console.log(
  JSON.stringify(
    {
      source: { width: sourceWidth, height: sourceHeight },
      rounds,
      warmup,
      iterations,
      profiles: aggregate
    },
    null,
    2
  )
);

if (gateProfile) {
  const candidate = aggregate.find((item) => item.name === gateProfile);
  if (!candidate) {
    console.error(`Unknown --gate-profile "${gateProfile}".`);
    process.exit(3);
  }

  const p95Pass = candidate.relativeP95 <= maxRelativeP95;
  const bytesPass = candidate.relativeBytes <= maxRelativeBytes;

  console.log(
    `\nGate ${gateProfile}: p95 ${formatPercent(candidate.relativeP95)} <= ${formatPercent(maxRelativeP95)}; bytes ${formatPercent(candidate.relativeBytes)} <= ${formatPercent(maxRelativeBytes)}`
  );

  if (!p95Pass || !bytesPass) {
    process.exit(1);
  }
}

async function compile() {
  await execFileAsync("xcrun", [
    "clang",
    source,
    "-o",
    binary,
    "-framework",
    "Foundation",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ImageIO",
    "-framework",
    "IOSurface",
    "-fno-objc-arc",
    "-O3"
  ]);
}

async function runProfile(profile) {
  const { stdout } = await execFileAsync(binary, [
    "--benchmark",
    "--source-width",
    String(sourceWidth),
    "--source-height",
    String(sourceHeight),
    "--width",
    String(profile.width),
    "--quality",
    String(profile.quality),
    "--warmup",
    String(warmup),
    "--iterations",
    String(iterations)
  ], {
    maxBuffer: 1024 * 1024
  });

  return JSON.parse(stdout.trim());
}

function printTable(rows) {
  const header = [
    "profile".padEnd(10),
    "size".padEnd(11),
    "quality".padStart(7),
    "p50 ms".padStart(8),
    "p95 ms".padStart(8),
    "p95 fps".padStart(8),
    "avg KB".padStart(8),
    "p95 Δ".padStart(8),
    "bytes Δ".padStart(8)
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    console.log(
      [
        row.name.padEnd(10),
        `${row.width}×${row.outputHeight}`.padEnd(11),
        row.quality.toFixed(2).padStart(7),
        row.p50Ms.toFixed(2).padStart(8),
        row.p95Ms.toFixed(2).padStart(8),
        row.capacityFpsP95.toFixed(1).padStart(8),
        (row.avgBytes / 1024).toFixed(1).padStart(8),
        formatPercent(row.relativeP95).padStart(8),
        formatPercent(row.relativeBytes).padStart(8)
      ].join("  ")
    );
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}
