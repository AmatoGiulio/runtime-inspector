import test from "node:test";
import assert from "node:assert/strict";
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
const binary = path.join(buildDir, "simulator-framebuffer-benchmark-test");

test(
  "deterministic framebuffer benchmark exercises the native encoder path",
  { skip: process.platform !== "darwin" },
  async () => {
    await mkdir(buildDir, { recursive: true });

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

    const args = [
      "--benchmark",
      "--source-width",
      "360",
      "--source-height",
      "780",
      "--width",
      "240",
      "--quality",
      "0.60",
      "--warmup",
      "1",
      "--iterations",
      "3"
    ];

    const first = JSON.parse((await execFileAsync(binary, args)).stdout.trim());
    const second = JSON.parse((await execFileAsync(binary, args)).stdout.trim());

    for (const result of [first, second]) {
      assert.equal(result.sourceWidth, 360);
      assert.equal(result.sourceHeight, 780);
      assert.equal(result.outputWidth, 240);
      assert.equal(result.outputHeight, 520);
      assert.equal(result.quality, 0.6);
      assert.equal(result.warmup, 1);
      assert.equal(result.iterations, 3);
      assert.ok(result.avgMs > 0);
      assert.ok(result.p50Ms > 0);
      assert.ok(result.p95Ms > 0);
      assert.ok(result.avgBytes > 0);
    }

    // The workload is deterministic even though wall-clock timing is not.
    // Encoded dimensions and payload size must remain stable across runs.
    assert.equal(first.outputWidth, second.outputWidth);
    assert.equal(first.outputHeight, second.outputHeight);
    assert.equal(first.avgBytes, second.avgBytes);
  }
);
