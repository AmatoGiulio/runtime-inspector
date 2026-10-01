import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "simulator-input.swift");
const buildDir = path.join(os.tmpdir(), "runtime-inspector");
const binaryPath = path.join(buildDir, "simulator-input");

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
    this.buildPromise = undefined;
  }

  async getPermission(prompt = false) {
    const response = await this.request({ command: "permission", prompt });
    return Boolean(response.trusted);
  }

  async sendPointer(windowId, event) {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) {
      throw new Error("Simulator capture does not expose a valid macOS window id.");
    }

    const type = event?.type;
    if (!["down", "drag", "up"].includes(type)) {
      throw new Error("Unsupported Simulator pointer event.");
    }

    const x = clampUnit(event?.x);
    const y = clampUnit(event?.y);

    const response = await this.request({
      command: "pointer",
      windowId,
      type,
      x,
      y
    });

    if (!response.ok) {
      throw new Error(response.message || "Simulator input forwarding failed.");
    }
  }

  async request(payload) {
    await this.ensureChild();
    const id = this.nextId++;
    const message = { id, ...payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Simulator input helper timed out."));
      }, 3000);

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

    const child = spawn(binaryPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));

    child.on("exit", (code, signal) => {
      const error = new Error(
        `Simulator input helper exited (${signal || code || "unknown"}).`
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
    });

    child.stderr.on("data", () => {
      // Keep stderr drained; request failures are returned through stdout JSON.
    });

    this.child = child;
  }

  async ensureBuilt() {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      await mkdir(buildDir, { recursive: true });

      let needsBuild = true;
      try {
        const [sourceStat, binaryStat] = await Promise.all([stat(sourcePath), stat(binaryPath)]);
        needsBuild = sourceStat.mtimeMs > binaryStat.mtimeMs;
      } catch {
        needsBuild = true;
      }

      if (!needsBuild) return;

      await runProcess("xcrun", [
        "swiftc",
        sourcePath,
        "-O",
        "-framework",
        "ApplicationServices",
        "-framework",
        "CoreGraphics",
        "-o",
        binaryPath
      ]);
    })();

    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = undefined;
    }
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
