import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "simulator-hid.m");
const buildDir = path.join(os.tmpdir(), "runtime-inspector");
const binaryPath = path.join(buildDir, "simulator-hid");

export function parseDesktopWindowId(sourceId) {
  if (typeof sourceId !== "string") return undefined;
  const match = /^window:(\d+):/.exec(sourceId);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export class SimulatorInputHelper {
  constructor() {
    this.child = undefined;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.buildPromise = undefined;
    this.preparedUdid = undefined;
    this.developerDir = undefined;
  }

  async prepare(udid) {
    if (typeof udid !== "string" || !udid) {
      throw new Error("A Simulator UDID is required for HID input.");
    }

    const response = await this.request({ command: "prepare", udid });
    if (!response.ok) {
      throw new Error(response.message || "Simulator HID preparation failed.");
    }
    this.preparedUdid = udid;
    return true;
  }

  async sendPointer(udid, event) {
    if (this.preparedUdid !== udid) {
      await this.prepare(udid);
    }

    const type = event?.type;
    if (!["down", "drag", "up"].includes(type)) {
      throw new Error("Unsupported Simulator pointer event.");
    }

    const response = await this.request({
      command: "pointer",
      type,
      x: clampUnit(event?.x),
      y: clampUnit(event?.y)
    });

    if (!response.ok) {
      throw new Error(response.message || "Simulator HID input failed.");
    }
  }

  async request(payload) {
    await this.ensureChild();
    const id = this.nextId++;
    const message = { id, ...payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            this.stderrBuffer.trim() ||
              "Simulator HID helper timed out."
          )
        );
      }, 4000);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ensureChild() {
    if (this.child && !this.child.killed) return;
    await this.ensureBuilt();

    const developerDir = await this.resolveDeveloperDir();
    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RI_DEVELOPER_DIR: developerDir
      }
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 8000) {
        this.stderrBuffer = this.stderrBuffer.slice(-8000);
      }
    });

    child.on("exit", (code, signal) => {
      const detail = this.stderrBuffer.trim();
      const error = new Error(
        detail ||
          `Simulator HID helper exited (${signal || code || "unknown"}).`
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.preparedUdid = undefined;
      this.child = undefined;
    });

    this.child = child;
  }

  async ensureBuilt() {
    if (this.buildPromise) return this.buildPromise;

    this.buildPromise = (async () => {
      await mkdir(buildDir, { recursive: true });

      let needsBuild = true;
      try {
        const [sourceStat, binaryStat] = await Promise.all([
          stat(sourcePath),
          stat(binaryPath)
        ]);
        needsBuild = sourceStat.mtimeMs > binaryStat.mtimeMs;
      } catch {
        needsBuild = true;
      }

      if (!needsBuild) return;

      const developerDir = await this.resolveDeveloperDir();
      const privateFrameworks = path.join(
        developerDir,
        "Library",
        "PrivateFrameworks"
      );

      await runProcess("xcrun", [
        "clang",
        sourcePath,
        "-o",
        binaryPath,
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        "-F/Library/Developer/PrivateFrameworks",
        "-framework",
        "CoreSimulator",
        "-rpath",
        "/Library/Developer/PrivateFrameworks",
        "-rpath",
        privateFrameworks,
        "-fno-objc-arc",
        "-O2"
      ]);
    })();

    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = undefined;
    }
  }

  async resolveDeveloperDir() {
    if (this.developerDir) return this.developerDir;
    const { stdout } = await execFileAsync("xcode-select", ["-p"]);
    const value = stdout.trim();
    if (!value) {
      throw new Error("xcode-select did not return an active Xcode developer directory.");
    }
    this.developerDir = value;
    return value;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  dispose() {
    this.child?.kill();
    this.child = undefined;
    this.preparedUdid = undefined;
  }
}

function clampUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error("Pointer coordinates must be finite.");
  }
  return Math.min(1, Math.max(0, number));
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `${command} exited with code ${code}.`));
      }
    });
  });
}
