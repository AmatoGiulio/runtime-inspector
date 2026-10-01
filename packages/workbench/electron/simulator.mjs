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

export function normalizeSimulatorDeviceCrop(entry, referenceAspect) {
  if (
    !entry ||
    !Number.isFinite(referenceAspect) ||
    referenceAspect <= 0 ||
    !Number.isFinite(entry.windowX) ||
    !Number.isFinite(entry.windowY) ||
    !Number.isFinite(entry.windowWidth) ||
    !Number.isFinite(entry.windowHeight) ||
    !Number.isFinite(entry.groupX) ||
    !Number.isFinite(entry.groupY) ||
    !Number.isFinite(entry.groupWidth) ||
    !Number.isFinite(entry.groupHeight) ||
    entry.windowWidth <= 0 ||
    entry.windowHeight <= 0 ||
    entry.groupWidth <= 0 ||
    entry.groupHeight <= 0
  ) {
    return undefined;
  }

  const crop = {
    x: (entry.groupX - entry.windowX) / entry.windowWidth,
    y: (entry.groupY - entry.windowY) / entry.windowHeight,
    width: entry.groupWidth / entry.windowWidth,
    height: entry.groupHeight / entry.windowHeight
  };

  if (
    crop.x < -0.02 ||
    crop.y < -0.02 ||
    crop.width <= 0.1 ||
    crop.height <= 0.3 ||
    crop.x + crop.width > 1.02 ||
    crop.y + crop.height > 1.02
  ) {
    return undefined;
  }

  const actualAspect = entry.groupWidth / entry.groupHeight;
  const aspectError = Math.abs(Math.log(actualAspect / referenceAspect));
  if (aspectError > 0.12) {
    return undefined;
  }

  return {
    x: Math.max(0, crop.x),
    y: Math.max(0, crop.y),
    width: Math.min(1, crop.width),
    height: Math.min(1, crop.height),
    score: aspectError,
    source: "accessibility"
  };
}

export async function getIOSSimulatorDeviceCrop(deviceName, referenceAspect) {
  const script = `
tell application "System Events"
  tell process "Simulator"
    set output to ""
    repeat with w in windows
      try
        set winName to name of w
        set winPos to position of w
        set winSize to size of w
        repeat with elem in (every UI element of w)
          try
            if role of elem is "AXGroup" then
              set groupPos to position of elem
              set groupSize to size of elem
              set output to output & winName & "|" & ((item 1 of winPos) as text) & "|" & ((item 2 of winPos) as text) & "|" & ((item 1 of winSize) as text) & "|" & ((item 2 of winSize) as text) & "|" & ((item 1 of groupPos) as text) & "|" & ((item 2 of groupPos) as text) & "|" & ((item 1 of groupSize) as text) & "|" & ((item 2 of groupSize) as text) & linefeed
            end if
          end try
        end repeat
      end try
    end repeat
    return output
  end tell
end tell
`;

  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: 4000,
    maxBuffer: 512 * 1024
  });

  const target = deviceName.toLowerCase();
  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|");
      if (parts.length < 9) return undefined;
      const [
        name,
        windowX,
        windowY,
        windowWidth,
        windowHeight,
        groupX,
        groupY,
        groupWidth,
        groupHeight
      ] = parts;
      return {
        name,
        windowX: Number(windowX),
        windowY: Number(windowY),
        windowWidth: Number(windowWidth),
        windowHeight: Number(windowHeight),
        groupX: Number(groupX),
        groupY: Number(groupY),
        groupWidth: Number(groupWidth),
        groupHeight: Number(groupHeight)
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.name.toLowerCase().includes(target))
    .map((entry) => ({
      entry,
      crop: normalizeSimulatorDeviceCrop(entry, referenceAspect)
    }))
    .filter((item) => item.crop)
    .sort((a, b) => {
      const aArea = a.crop.width * a.crop.height;
      const bArea = b.crop.width * b.crop.height;
      return a.crop.score - b.crop.score || bArea - aArea;
    });

  return candidates[0]?.crop;
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