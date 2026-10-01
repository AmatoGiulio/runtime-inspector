import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function flattenSimulatorDevices(payload) {
  const devicesByRuntime =
    payload && typeof payload === "object" && payload.devices && typeof payload.devices === "object"
      ? payload.devices
      : {};

  const result = [];

  for (const [runtimeId, devices] of Object.entries(devicesByRuntime)) {
    if (!runtimeId.includes(".SimRuntime.iOS-") || !Array.isArray(devices)) continue;

    for (const device of devices) {
      if (!device || typeof device !== "object") continue;
      if (device.isAvailable === false) continue;
      if (typeof device.udid !== "string" || typeof device.name !== "string") continue;

      result.push({
        udid: device.udid,
        name: device.name,
        state: typeof device.state === "string" ? device.state : "Unknown",
        runtimeId,
        runtime: runtimeLabel(runtimeId),
        isAvailable: device.isAvailable !== false
      });
    }
  }

  return result.sort((a, b) => {
    const bootScore = Number(b.state === "Booted") - Number(a.state === "Booted");
    if (bootScore !== 0) return bootScore;
    const runtimeScore = compareRuntimeLabels(b.runtime, a.runtime);
    if (runtimeScore !== 0) return runtimeScore;
    return a.name.localeCompare(b.name);
  });
}

export function runtimeLabel(runtimeId) {
  const marker = ".SimRuntime.iOS-";
  const index = runtimeId.indexOf(marker);
  if (index === -1) return runtimeId;
  return `iOS ${runtimeId.slice(index + marker.length).replaceAll("-", ".")}`;
}

export async function listIOSSimulators() {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    maxBuffer: 8 * 1024 * 1024
  });
  return flattenSimulatorDevices(JSON.parse(stdout));
}

export async function captureIOSSimulatorScreenshot(udid) {
  const { stdout } = await execFileAsync(
    "xcrun",
    ["simctl", "io", udid, "screenshot", "--type", "png", "--mask", "ignored", "-"],
    {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024
    }
  );

  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

export async function ensureIOSSimulatorBooted(udid) {
  const devices = await listIOSSimulators();
  const device = devices.find((item) => item.udid === udid);
  if (!device) {
    throw new Error(`Simulator ${udid} is not available.`);
  }

  if (device.state !== "Booted") {
    try {
      await execFileAsync("xcrun", ["simctl", "boot", udid]);
    } catch (error) {
      const detail = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
      if (!/already booted|current state:\s*Booted/i.test(detail)) {
        throw error;
      }
    }
  }

  await execFileAsync("open", ["-a", "Simulator"]);

  try {
    await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"], {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr, error?.message].filter(Boolean).join("\n");
    throw new Error(`Simulator did not finish booting: ${detail || "unknown error"}`);
  }

  const refreshed = await listIOSSimulators();
  return refreshed.find((item) => item.udid === udid) ?? { ...device, state: "Booted" };
}

function compareRuntimeLabels(a, b) {
  const parse = (label) =>
    label
      .replace(/^iOS\s+/i, "")
      .split(".")
      .map((part) => Number(part))
      .filter(Number.isFinite);

  const av = parse(a);
  const bv = parse(b);
  const length = Math.max(av.length, bv.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (av[i] ?? 0) - (bv[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}