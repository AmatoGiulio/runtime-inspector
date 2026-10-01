import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "simulator-hid.m");

test(
  "Simulator HID Objective-C helper typechecks on macOS",
  { skip: process.platform !== "darwin" },
  async () => {
    const { stderr } = await execFileAsync("xcrun", [
      "clang",
      "-fsyntax-only",
      "-fno-objc-arc",
      source,
      "-framework",
      "Foundation",
      "-framework",
      "CoreGraphics"
    ]);

    assert.equal(stderr.trim(), "");
  }
);
