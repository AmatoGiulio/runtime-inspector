import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import {
  SYSTEM_CHROME_DIR,
  SYSTEM_DEVICE_TYPES_DIR,
  chromeBundleName,
  deviceChromeGeometry,
  loadDeviceChrome,
  pngSize
} from "./device-chrome.mjs";

const profile = {
  chromeIdentifier: "com.apple.dt.devicekit.chrome.phone12",
  mainScreenWidth: 1320,
  mainScreenHeight: 2868,
  mainScreenScale: 3,
  framebufferMask: "MASK-UUID"
};

const chrome = {
  identifier: "com.apple.dt.devicekit.chrome.phone12",
  images: {
    topLeft: "Phone TL",
    composite: "PhoneComposite",
    sizing: { leftWidth: 18, rightWidth: 18, topHeight: 18, bottomHeight: 18 }
  },
  paths: { simpleOutsideBorder: { cornerRadiusX: 80, cornerRadiusY: 80 } }
};

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("chromeBundleName takes the last dot segment and rejects unsafe names", () => {
  assert.equal(chromeBundleName("com.apple.dt.devicekit.chrome.phone12"), "phone12");
  assert.equal(chromeBundleName("phone-1_a"), "phone-1_a");
  assert.equal(chromeBundleName("com.apple.chrome.phone 12"), undefined);
  assert.equal(chromeBundleName("com.apple.chrome.."), undefined);
  assert.equal(chromeBundleName("com.apple.chrome.a/b"), undefined);
  assert.equal(chromeBundleName(""), undefined);
  assert.equal(chromeBundleName(undefined), undefined);
});

test("deviceChromeGeometry derives point geometry from a valid fixture", () => {
  assert.deepEqual(deviceChromeGeometry({ profile, chrome }), {
    screen: { widthPt: 440, heightPt: 956 },
    bezel: { top: 18, right: 18, bottom: 18, left: 18 },
    cornerSlicePt: 110,
    outerCornerRadiusPt: 80,
    compositeName: "PhoneComposite",
    maskName: "MASK-UUID"
  });
});

test("deviceChromeGeometry honours a measured corner slice and tolerates a missing mask/radius", () => {
  const geometry = deviceChromeGeometry({
    profile: { ...profile, framebufferMask: undefined },
    chrome: { ...chrome, paths: undefined },
    cornerSlicePt: 96
  });
  assert.equal(geometry.cornerSlicePt, 96);
  assert.equal(geometry.outerCornerRadiusPt, undefined);
  assert.equal(geometry.maskName, undefined);
});

test("deviceChromeGeometry rejects missing sizing, zero scale and unsafe names", () => {
  assert.equal(
    deviceChromeGeometry({ profile, chrome: { ...chrome, images: { composite: "PhoneComposite" } } }),
    undefined
  );
  assert.equal(deviceChromeGeometry({ profile: { ...profile, mainScreenScale: 0 }, chrome }), undefined);
  assert.equal(deviceChromeGeometry({ profile: { ...profile, mainScreenWidth: Infinity }, chrome }), undefined);
  assert.equal(
    deviceChromeGeometry({
      profile,
      chrome: {
        ...chrome,
        images: { ...chrome.images, sizing: { ...chrome.images.sizing, topHeight: 0 } }
      }
    }),
    undefined
  );
  assert.equal(
    deviceChromeGeometry({ profile, chrome: { ...chrome, images: { ...chrome.images, composite: "../x" } } }),
    undefined
  );
  assert.equal(deviceChromeGeometry({}), undefined);
  assert.equal(deviceChromeGeometry(), undefined);
});

test("pngSize reads the IHDR and rejects non-PNG data", () => {
  assert.deepEqual(pngSize(pngBuffer(1422, 2970)), { width: 1422, height: 2970 });
  assert.throws(() => pngSize(Buffer.from("not a png at all, definitely not")));
});

const DEVICE_TYPE_ID = "com.apple.CoreSimulator.SimDeviceType.iPhone-99";
const BUNDLE = `${SYSTEM_DEVICE_TYPES_DIR}/iPhone 99.simdevicetype`;
const RESOURCES = `${BUNDLE}/Contents/Resources`;
const CHROME_RESOURCES = `${SYSTEM_CHROME_DIR}/phone12.devicechrome/Contents/Resources`;
const CACHE = "/cache";

function createFakes({ failPlutil = false, failSips = false, withMaskPdf = true } = {}) {
  const files = new Map();
  const dirs = new Map();
  const calls = [];
  const set = (file, value) => files.set(file, value);

  dirs.set(SYSTEM_DEVICE_TYPES_DIR, ["Decoy.simdevicetype", "iPhone 99.simdevicetype", "notes.txt"]);
  set(`${SYSTEM_DEVICE_TYPES_DIR}/Decoy.simdevicetype/Contents/Info.plist`, {
    CFBundleIdentifier: "com.apple.CoreSimulator.SimDeviceType.Decoy"
  });
  set(`${BUNDLE}/Contents/Info.plist`, {
    CFBundleIdentifier: DEVICE_TYPE_ID,
    CFBundleName: "iPhone 99"
  });
  set(`${RESOURCES}/profile.plist`, profile);
  if (withMaskPdf) set(`${RESOURCES}/MASK-UUID.pdf`, "pdf");
  set(`${CHROME_RESOURCES}/chrome.json`, JSON.stringify(chrome));
  set(`${CHROME_RESOURCES}/PhoneComposite.pdf`, "pdf");
  set(`${CHROME_RESOURCES}/Phone TL.pdf`, "pdf");

  const pdfSizes = new Map([
    [`${CHROME_RESOURCES}/PhoneComposite.pdf`, [474, 990]],
    [`${CHROME_RESOURCES}/Phone TL.pdf`, [110, 110]],
    [`${RESOURCES}/MASK-UUID.pdf`, [1320, 2868]]
  ]);

  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "xcode-select") throw new Error("xcode-select unavailable");
    if (file === "plutil") {
      if (failPlutil) throw new Error("plutil failed");
      const target = args[args.length - 1];
      if (!files.has(target)) throw new Error(`no such plist ${target}`);
      return { stdout: JSON.stringify(files.get(target)) };
    }
    if (file === "sips") {
      if (failSips) throw new Error("sips failed");
      if (args[0] === "-g") {
        const size = pdfSizes.get(args[args.length - 1]);
        if (!size) throw new Error("sips: no such file");
        return { stdout: `file\n  pixelWidth: ${size[0]}.000\n  pixelHeight: ${size[1]}.000\n` };
      }
      const max = Number(args[args.indexOf("-Z") + 1]);
      const source = args[args.indexOf("-Z") + 2];
      const out = args[args.indexOf("--out") + 1];
      const [width, height] = pdfSizes.get(source);
      const scale = max / Math.max(width, height);
      files.set(out, pngBuffer(Math.round(width * scale), Math.round(height * scale)));
      return { stdout: "" };
    }
    throw new Error(`unexpected command ${file}`);
  };

  const missing = (file) => Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  const fs = {
    readdir: async (dir) => {
      if (!dirs.has(dir)) throw missing(dir);
      return dirs.get(dir);
    },
    stat: async (file) => {
      if (!files.has(file)) throw missing(file);
      const value = files.get(file);
      return { mtimeMs: 1, size: typeof value === "string" || Buffer.isBuffer(value) ? value.length : 1 };
    },
    readFile: async (file, encoding) => {
      if (!files.has(file)) throw missing(file);
      const value = files.get(file);
      if (Buffer.isBuffer(value)) return encoding ? value.toString(encoding) : value;
      return value;
    },
    mkdir: async () => undefined,
    rename: async (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    }
  };

  return { execFile, fs, files, calls };
}

test("loadDeviceChrome returns geometry, composite and mask from injected fakes", async () => {
  const { execFile, fs, calls } = createFakes();
  const warnings = [];
  const result = await loadDeviceChrome(DEVICE_TYPE_ID, {
    cacheDir: CACHE,
    execFile,
    fs,
    memo: new Map(),
    warn: (message) => warnings.push(message)
  });

  assert.ok(result);
  assert.equal(result.deviceTypeIdentifier, DEVICE_TYPE_ID);
  assert.equal(result.name, "iPhone 99");
  assert.deepEqual(result.geometry, {
    screen: { widthPt: 440, heightPt: 956 },
    bezel: { top: 18, right: 18, bottom: 18, left: 18 },
    cornerSlicePt: 110,
    outerCornerRadiusPt: 80,
    compositeName: "PhoneComposite",
    maskName: "MASK-UUID"
  });
  assert.deepEqual(result.compositeSizePx, { width: 1422, height: 2970 });
  assert.equal(result.compositeScale, 3);
  assert.match(result.compositeDataUrl, /^data:image\/png;base64,/);
  assert.match(result.maskDataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(warnings, []);

  // sips receives argument arrays, never a shell string, and writes only inside the cache dir.
  const rasterizations = calls.filter((call) => call[0] === "sips" && call[1] === "-s");
  assert.equal(rasterizations.length, 2);
  for (const call of rasterizations) {
    assert.ok(call[call.indexOf("--out") + 1].startsWith(`${CACHE}/`));
  }
  assert.ok(rasterizations.some((call) => call.includes("2970")));
  assert.ok(rasterizations.some((call) => call.includes("1200")));
});

test("loadDeviceChrome memoizes per identifier and reuses cached rasters", async () => {
  const fakes = createFakes();
  const memo = new Map();
  const options = { cacheDir: CACHE, execFile: fakes.execFile, fs: fakes.fs, memo };
  const first = await loadDeviceChrome(DEVICE_TYPE_ID, options);
  const callCount = fakes.calls.length;
  const second = await loadDeviceChrome(DEVICE_TYPE_ID, options);
  assert.equal(second, first);
  assert.equal(fakes.calls.length, callCount);

  // A fresh memo (new process) re-reads the sources but reuses the rasterized cache files.
  const third = await loadDeviceChrome(DEVICE_TYPE_ID, { ...options, memo: new Map() });
  assert.ok(third);
  assert.equal(fakes.calls.filter((call) => call[0] === "sips" && call[1] === "-s").length, 2);
});

test("loadDeviceChrome degrades to no mask when the mask cannot be rasterized", async () => {
  const { execFile, fs } = createFakes({ withMaskPdf: false });
  const result = await loadDeviceChrome(DEVICE_TYPE_ID, {
    cacheDir: CACHE,
    execFile,
    fs,
    memo: new Map()
  });
  assert.ok(result);
  assert.equal(result.maskDataUrl, undefined);
  assert.match(result.compositeDataUrl, /^data:image\/png/);
});

test("loadDeviceChrome resolves undefined with one warning for every kind of failure", async () => {
  const cases = [
    ["plutil failure", createFakes({ failPlutil: true }), DEVICE_TYPE_ID],
    ["sips failure", createFakes({ failSips: true }), DEVICE_TYPE_ID],
    ["unknown device type", createFakes(), "com.apple.CoreSimulator.SimDeviceType.Nope"],
    ["invalid identifier", createFakes(), "../../etc/passwd"],
    [
      "unreadable filesystem",
      {
        ...createFakes(),
        fs: {
          readdir: async () => {
            throw new Error("EACCES");
          },
          readFile: async () => {
            throw new Error("EACCES");
          },
          stat: async () => {
            throw new Error("EACCES");
          },
          mkdir: async () => {
            throw new Error("EACCES");
          },
          rename: async () => {
            throw new Error("EACCES");
          }
        }
      },
      DEVICE_TYPE_ID
    ]
  ];

  for (const [label, fakes, identifier] of cases) {
    const warnings = [];
    const result = await loadDeviceChrome(identifier, {
      cacheDir: CACHE,
      execFile: fakes.execFile,
      fs: fakes.fs,
      memo: new Map(),
      warn: (message) => warnings.push(message)
    });
    assert.equal(result, undefined, label);
    assert.equal(warnings.length, 1, label);
  }

  const warnings = [];
  const noCache = await loadDeviceChrome(DEVICE_TYPE_ID, {
    execFile: createFakes().execFile,
    fs: createFakes().fs,
    memo: new Map(),
    warn: (message) => warnings.push(message)
  });
  assert.equal(noCache, undefined);
  assert.equal(warnings.length, 1);
});

test("loadDeviceChrome rejects a chrome.json that does not match the profile", async () => {
  const fakes = createFakes();
  fakes.files.set(
    `${CHROME_RESOURCES}/chrome.json`,
    JSON.stringify({ ...chrome, identifier: "com.apple.dt.devicekit.chrome.other" })
  );
  const result = await loadDeviceChrome(DEVICE_TYPE_ID, {
    cacheDir: CACHE,
    execFile: fakes.execFile,
    fs: fakes.fs,
    memo: new Map(),
    warn: () => undefined
  });
  assert.equal(result, undefined);
});

test("loadDeviceChrome loads real Xcode chrome for an installed iPhone device type", async (t) => {
  if (!existsSync(SYSTEM_CHROME_DIR) || !existsSync(SYSTEM_DEVICE_TYPES_DIR)) {
    t.skip("Xcode device chrome is not installed on this machine.");
    return;
  }

  const execFileAsync = promisify(nodeExecFile);
  const names = (await fsPromises.readdir(SYSTEM_DEVICE_TYPES_DIR))
    .filter((name) => name.startsWith("iPhone") && name.endsWith(".simdevicetype"))
    .sort();
  if (names.length === 0) {
    t.skip("No iPhone device types are installed.");
    return;
  }

  const cacheDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ri-device-chrome-"));
  try {
    let loaded;
    for (const name of names) {
      const { stdout } = await execFileAsync("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(SYSTEM_DEVICE_TYPES_DIR, name, "Contents", "Info.plist")
      ]);
      const identifier = JSON.parse(stdout).CFBundleIdentifier;
      loaded = await loadDeviceChrome(identifier, { cacheDir, memo: new Map(), warn: () => undefined });
      if (loaded) break;
    }

    assert.ok(loaded, "at least one installed iPhone device type should resolve real chrome");
    assert.match(loaded.compositeDataUrl, /^data:image\/png;base64,/);
    assert.ok(loaded.compositeSizePx.width > 0 && loaded.compositeSizePx.height > 0);
    assert.ok(loaded.geometry.screen.widthPt > 0 && loaded.geometry.screen.heightPt > 0);
    assert.ok(loaded.geometry.bezel.top > 0 && loaded.geometry.bezel.left > 0);
    assert.ok(loaded.geometry.cornerSlicePt > 0);
  } finally {
    await fsPromises.rm(cacheDir, { recursive: true, force: true });
  }
});
