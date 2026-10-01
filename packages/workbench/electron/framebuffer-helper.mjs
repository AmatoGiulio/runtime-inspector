import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "simulator-framebuffer.m");
const buildDir = path.join(os.tmpdir(), "runtime-inspector");
const binaryPath = path.join(buildDir, "simulator-framebuffer");
const HEADER_SIZE = 32;
const MAGIC = 0x52494642;

export function parseSimulatorFramebufferStatusLine(line) {
  if (typeof line !== "string" || !line.startsWith("RI_STATUS:")) return undefined;

  const message = line.slice("RI_STATUS:".length).trim();
  const frameSourceMatch = message.match(/^frame-source=([^\s]+)(?:\s+(.*))?$/);
  if (!frameSourceMatch) return { message };

  return {
    message,
    frameSource: frameSourceMatch[1],
    detail: frameSourceMatch[2]
  };
}

export class SimulatorFramebufferParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= HEADER_SIZE) {
      const magic = this.buffer.readUInt32BE(0);
      if (magic !== MAGIC) {
        throw new Error(
          `Invalid Simulator framebuffer stream magic 0x${magic.toString(16)}.`
        );
      }

      const payloadLength = this.buffer.readUInt32BE(4);
      const width = this.buffer.readUInt32BE(8);
      const height = this.buffer.readUInt32BE(12);
      const sequence = this.buffer.readUInt32BE(16);
      const capturedAtMs = Number(this.buffer.readBigUInt64BE(20));
      const encodeDurationUs = this.buffer.readUInt32BE(28);
      const frameLength = HEADER_SIZE + payloadLength;
      if (this.buffer.length < frameLength) return;

      const bytes = Buffer.from(this.buffer.subarray(HEADER_SIZE, frameLength));
      this.buffer = this.buffer.subarray(frameLength);

      this.onFrame({
        sequence,
        width,
        height,
        capturedAtMs,
        encodeDurationUs,
        mimeType: "image/jpeg",
        bytes
      });
    }
  }
}

export class SimulatorFramebufferHelper {
  constructor() {
    this.child = undefined;
    this.buildPromise = undefined;
    this.developerDir = undefined;
    this.stderrBuffer = "";
  }

  async start({
    udid,
    fps = 60,
    width = 640,
    quality = 0.72,
    pollIntervalUs = 500,
    onFrame,
    onStatus,
    onError
  }) {
    await this.stop();
    await this.ensureBuilt();

    const developerDir = await this.resolveDeveloperDir();
    const parser = new SimulatorFramebufferParser((frame) => {
      onFrame?.({
        ...frame,
        receivedAtMs: Date.now()
      });
    });

    const child = spawn(
      binaryPath,
      [
        "--udid",
        udid,
        "--fps",
        String(fps),
        "--width",
        String(width),
        "--quality",
        String(quality),
        "--poll-us",
        String(pollIntervalUs)
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          RI_DEVELOPER_DIR: developerDir
        }
      }
    );

    this.stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk;
      for (const line of String(chunk).split(/\r?\n/)) {
        const status = parseSimulatorFramebufferStatusLine(line);
        if (status) {
          console.log(`[Runtime Inspector] ${status.message}`);
          onStatus?.(status);
        }
      }
      if (this.stderrBuffer.length > 16000) {
        this.stderrBuffer = this.stderrBuffer.slice(-16000);
      }
    });

    child.stdout.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        onError?.(error);
        void this.stop();
      }
    });

    child.on("error", (error) => {
      onError?.(error);
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;

      if (code === 0 || signal === "SIGTERM") return;
      const detail = this.stderrBuffer.trim();
      onError?.(
        new Error(
          detail ||
            `Simulator framebuffer helper exited (${signal || code || "unknown"}).`
        )
      );
    });

    this.child = child;
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;

    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
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

      await runProcess("xcrun", [
        "clang",
        sourcePath,
        "-o",
        binaryPath,
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        "-framework",
        "ImageIO",
        "-framework",
        "IOSurface",
        "-fno-objc-arc",
        "-fblocks",
        "-O3"
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