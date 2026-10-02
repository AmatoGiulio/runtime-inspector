import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// Device chrome (the real iPhone bezel) is read at runtime from the user's own Xcode
// installation and rasterized into a cache directory owned by the app. Nothing here is copied
// into the repo or bundled. The layout of these folders is private Xcode tooling, so every
// failure degrades to `undefined` ("no chrome" -> the generic frame) and never throws.
//
// This is a transport-local device-adapter concern: none of it belongs in RIP.

const defaultExecFile = promisify(nodeExecFile);

export const SYSTEM_DEVICE_TYPES_DIR = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
export const SYSTEM_CHROME_DIR = "/Library/Developer/DeviceKit/Chrome";
const XCODE_DEVICE_TYPES_SUFFIX =
  "Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const XCODE_CHROME_SUFFIX = "Platforms/iPhoneOS.platform/Library/Developer/DeviceKit/Chrome";

/** The composite is rasterized at this many pixels per point. */
export const COMPOSITE_RASTER_SCALE = 3;
/** Longest side, in pixels, of the rasterized framebuffer mask. */
export const MASK_MAX_PIXELS = 1200;
export const DEFAULT_CORNER_SLICE_PT = 110;

const defaultMemo = new Map();

/** Last dot segment of a chrome identifier ("...chrome.phone12" -> "phone12"). */
export function chromeBundleName(chromeIdentifier) {
  if (typeof chromeIdentifier !== "string") return undefined;
  const name = chromeIdentifier.slice(chromeIdentifier.lastIndexOf(".") + 1);
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : undefined;
}

function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A single path segment inside a bundle: no separators, no traversal, no NUL. */
function isSafeResourceName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

/**
 * Pure geometry derivation from a simdevicetype `profile.plist` and a `chrome.json`
 * (both already parsed). Returns undefined when any required field is missing or invalid.
 */
export function deviceChromeGeometry({ profile, chrome, cornerSlicePt } = {}) {
  if (!profile || typeof profile !== "object" || !chrome || typeof chrome !== "object") {
    return undefined;
  }

  const { mainScreenWidth, mainScreenHeight, mainScreenScale } = profile;
  if (!positive(mainScreenWidth) || !positive(mainScreenHeight) || !positive(mainScreenScale)) {
    return undefined;
  }

  const images = chrome.images;
  if (!images || typeof images !== "object") return undefined;

  const sizing = images.sizing;
  if (!sizing || typeof sizing !== "object") return undefined;
  const { topHeight, rightWidth, bottomHeight, leftWidth } = sizing;
  if (!positive(topHeight) || !positive(rightWidth) || !positive(bottomHeight) || !positive(leftWidth)) {
    return undefined;
  }

  if (!isSafeResourceName(images.composite)) return undefined;

  const maskName = isSafeResourceName(profile.framebufferMask) ? profile.framebufferMask : undefined;
  const radius = chrome.paths?.simpleOutsideBorder?.cornerRadiusX;

  return {
    screen: {
      widthPt: mainScreenWidth / mainScreenScale,
      heightPt: mainScreenHeight / mainScreenScale
    },
    bezel: { top: topHeight, right: rightWidth, bottom: bottomHeight, left: leftWidth },
    cornerSlicePt: positive(cornerSlicePt) ? cornerSlicePt : DEFAULT_CORNER_SLICE_PT,
    outerCornerRadiusPt: positive(radius) ? radius : undefined,
    compositeName: images.composite,
    maskName
  };
}

/** Reads the IHDR width/height of a PNG buffer. */
export function pngSize(buffer) {
  if (
    !buffer ||
    buffer.length < 24 ||
    buffer.readUInt32BE(0) !== 0x89504e47 ||
    buffer.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    throw new Error("Rasterized image is not a PNG.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("Rasterized PNG has no size.");
  return { width, height };
}

function parseSipsDimensions(stdout) {
  const width = /pixelWidth:\s*([0-9.]+)/.exec(String(stdout))?.[1];
  const height = /pixelHeight:\s*([0-9.]+)/.exec(String(stdout))?.[1];
  const size = { width: Number(width), height: Number(height) };
  if (!positive(size.width) || !positive(size.height)) {
    throw new Error("sips did not report an image size.");
  }
  return size;
}

/**
 * Loads and rasterizes the real device chrome for a CoreSimulator device type identifier.
 * Dependency-injected (`execFile`, `fs`) for tests. Never throws; resolves `undefined` when the
 * chrome cannot be produced, after emitting one warning.
 */
export function loadDeviceChrome(deviceTypeIdentifier, options = {}) {
  const memo = options.memo ?? defaultMemo;
  const key = `${options.cacheDir ?? ""}\0${deviceTypeIdentifier}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const pending = loadUncached(deviceTypeIdentifier, options).catch((error) => {
    const warn = options.warn ?? console.warn;
    try {
      warn(
        `[Runtime Inspector] No device chrome for ${String(deviceTypeIdentifier)}; using the generic frame. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } catch {
      // a warning must never throw
    }
    return undefined;
  });

  memo.set(key, pending);
  return pending;
}

async function loadUncached(deviceTypeIdentifier, options) {
  const execFile = options.execFile ?? defaultExecFile;
  const fs = options.fs ?? fsPromises;
  const cacheDir = options.cacheDir;

  if (typeof deviceTypeIdentifier !== "string" || !/^[A-Za-z0-9._-]+$/.test(deviceTypeIdentifier)) {
    throw new Error("Invalid device type identifier.");
  }
  if (typeof cacheDir !== "string" || cacheDir.length === 0) {
    throw new Error("A cache directory is required.");
  }

  const run = async (file, args) => {
    const result = await execFile(file, args, { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 });
    return typeof result === "string" ? result : String(result?.stdout ?? "");
  };
  const readPlist = async (file) => {
    const parsed = JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", file]));
    if (!parsed || typeof parsed !== "object") throw new Error(`Unexpected plist: ${file}`);
    return parsed;
  };

  const roots = await locateRoots({ run });
  const bundle = await findDeviceTypeBundle(deviceTypeIdentifier, { fs, readPlist, roots });
  if (!bundle) throw new Error("Device type bundle not found.");

  const resources = path.join(bundle.dir, "Contents", "Resources");
  const profile = await readPlist(path.join(resources, "profile.plist"));

  const chromeName = chromeBundleName(profile.chromeIdentifier);
  if (!chromeName) throw new Error("Unknown chrome identifier.");

  const chromeResources = await findChromeResources(chromeName, { fs, roots });
  if (!chromeResources) throw new Error(`Chrome bundle "${chromeName}" not found.`);
  const chrome = JSON.parse(await fs.readFile(path.join(chromeResources, "chrome.json"), "utf8"));
  if (
    chrome &&
    typeof chrome.identifier === "string" &&
    typeof profile.chromeIdentifier === "string" &&
    chrome.identifier !== profile.chromeIdentifier
  ) {
    throw new Error("chrome.json does not match the device chrome identifier.");
  }

  // The corner slice size is the point size of the top-left image (110 pt on current phones).
  let cornerSlicePt;
  if (isSafeResourceName(chrome?.images?.topLeft)) {
    try {
      const size = parseSipsDimensions(
        await run("sips", [
          "-g",
          "pixelWidth",
          "-g",
          "pixelHeight",
          path.join(chromeResources, `${chrome.images.topLeft}.pdf`)
        ])
      );
      cornerSlicePt = Math.min(size.width, size.height);
    } catch {
      cornerSlicePt = undefined;
    }
  }

  const geometry = deviceChromeGeometry({ profile, chrome, cornerSlicePt });
  if (!geometry) throw new Error("Chrome geometry is missing or invalid.");

  await fs.mkdir(cacheDir, { recursive: true });

  const compositePdf = path.join(chromeResources, `${geometry.compositeName}.pdf`);
  const compositePt = parseSipsDimensions(
    await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", compositePdf])
  );
  const compositePng = await rasterize({
    kind: "composite",
    source: compositePdf,
    maxPixels: Math.round(Math.max(compositePt.width, compositePt.height) * COMPOSITE_RASTER_SCALE),
    cacheDir,
    fs,
    run
  });
  const compositeBuffer = await fs.readFile(compositePng);
  const compositeSizePx = pngSize(compositeBuffer);

  let maskDataUrl;
  if (geometry.maskName) {
    try {
      const maskPng = await rasterize({
        kind: "mask",
        source: path.join(resources, `${geometry.maskName}.pdf`),
        maxPixels: MASK_MAX_PIXELS,
        cacheDir,
        fs,
        run
      });
      const maskBuffer = await fs.readFile(maskPng);
      pngSize(maskBuffer);
      maskDataUrl = toDataUrl(maskBuffer);
    } catch {
      // The mask is an enhancement: without it the renderer falls back to a corner radius.
      maskDataUrl = undefined;
    }
  }

  return {
    deviceTypeIdentifier,
    name: typeof bundle.info.CFBundleName === "string" ? bundle.info.CFBundleName : deviceTypeIdentifier,
    geometry,
    compositeDataUrl: toDataUrl(compositeBuffer),
    compositeSizePx,
    compositeScale: compositeSizePx.width / compositePt.width,
    ...(maskDataUrl ? { maskDataUrl } : {})
  };
}

function toDataUrl(buffer) {
  return `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
}

async function locateRoots({ run }) {
  const deviceTypeDirs = [SYSTEM_DEVICE_TYPES_DIR];
  const chromeDirs = [SYSTEM_CHROME_DIR];
  try {
    const developerDir = (await run("xcode-select", ["-p"])).trim();
    if (developerDir.startsWith("/")) {
      deviceTypeDirs.push(path.join(developerDir, XCODE_DEVICE_TYPES_SUFFIX));
      chromeDirs.push(path.join(developerDir, XCODE_CHROME_SUFFIX));
    }
  } catch {
    // The system locations are still tried.
  }
  return { deviceTypeDirs, chromeDirs };
}

async function findDeviceTypeBundle(identifier, { fs, readPlist, roots }) {
  // "…SimDeviceType.iPhone-17-Pro-Max" usually lives in "iPhone 17 Pro Max.simdevicetype":
  // try that first so the common case needs one plist read instead of a full scan.
  const guess = `${identifier.slice(identifier.lastIndexOf(".") + 1).replaceAll("-", " ")}.simdevicetype`;

  const candidates = [];
  for (const dir of roots.deviceTypeDirs) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (typeof name === "string" && name.endsWith(".simdevicetype")) {
        candidates.push({ dir: path.join(dir, name), isGuess: name === guess });
      }
    }
  }
  candidates.sort((a, b) => Number(b.isGuess) - Number(a.isGuess));

  const matches = async ({ dir }) => {
    try {
      const info = await readPlist(path.join(dir, "Contents", "Info.plist"));
      return info.CFBundleIdentifier === identifier ? { dir, info } : undefined;
    } catch {
      return undefined;
    }
  };

  const first = candidates[0]?.isGuess ? await matches(candidates[0]) : undefined;
  if (first) return first;

  const BATCH = 8;
  for (let index = 0; index < candidates.length; index += BATCH) {
    const found = (await Promise.all(candidates.slice(index, index + BATCH).map(matches))).find(Boolean);
    if (found) return found;
  }
  return undefined;
}

async function findChromeResources(chromeName, { fs, roots }) {
  for (const dir of roots.chromeDirs) {
    const resources = path.join(dir, `${chromeName}.devicechrome`, "Contents", "Resources");
    try {
      await fs.readFile(path.join(resources, "chrome.json"), "utf8");
      return resources;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

async function rasterize({ kind, source, maxPixels, cacheDir, fs, run }) {
  const stat = await fs.stat(source);
  const hash = createHash("sha1")
    .update(`${source}\0${stat.mtimeMs}\0${stat.size}`)
    .digest("hex")
    .slice(0, 16);
  const target = path.join(cacheDir, `${kind}-${hash}-${maxPixels}.png`);

  try {
    const existing = await fs.stat(target);
    if (existing.size > 0) return target;
  } catch {
    // not cached yet
  }

  // sips derives nothing from the name but warns on a non-.png suffix, so keep the suffix.
  const partial = path.join(cacheDir, `${kind}-${hash}-${maxPixels}.${process.pid}.partial.png`);
  await run("sips", ["-s", "format", "png", "-Z", String(maxPixels), source, "--out", partial]);
  await fs.rename(partial, target);
  return target;
}
