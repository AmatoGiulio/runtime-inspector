import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, session, systemPreferences } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import {
  captureIOSSimulatorScreenshot,
  ensureIOSSimulatorBooted,
  listIOSSimulators
} from "./simulator.mjs";
import { parseDesktopWindowId, SimulatorInputHelper } from "./input-helper.mjs";
import { findNormalizedCrop } from "./crop.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const isDev = process.argv.includes("--dev");
const rendererPort = Number(process.env.VITE_RI_WORKBENCH_PORT ?? 4610);
const panelToken = process.env.VITE_RI_TOKEN;

let viteServer;
let selectedCaptureSourceId;
let selectedCaptureWindowId;
let selectedSimulator;
const simulatorInput = new SimulatorInputHelper();

app.setName("Runtime Inspector");

app.whenReady().then(async () => {
  registerDesktopIpc();
  registerDisplayCaptureHandler();

  const rendererUrl = await startRenderer();
  await createWindow(rendererUrl);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow(rendererUrl);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  } else {
    app.quit();
  }
});

app.on("before-quit", async () => {
  simulatorInput.dispose();
  if (viteServer) {
    try {
      await viteServer.close();
    } catch {
      // best-effort dev-server shutdown
    }
    viteServer = undefined;
  }
});

async function startRenderer() {
  if (!isDev) {
    return pathToFileURL(path.join(packageRoot, "dist", "index.html")).toString();
  }

  viteServer = await createServer({
    root: packageRoot,
    configFile: path.join(packageRoot, "vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: rendererPort,
      strictPort: true
    }
  });
  await viteServer.listen();

  const url = new URL(`http://127.0.0.1:${rendererPort}`);
  if (panelToken) url.searchParams.set("token", panelToken);
  return url.toString();
}

async function createWindow(rendererUrl) {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    title: "Runtime Inspector Workbench",
    backgroundColor: "#111113",
    show: false,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());
  await window.loadURL(rendererUrl);
}

function registerDesktopIpc() {
  ipcMain.handle("runtime-desktop:get-info", async () => ({
    platform: process.platform,
    desktop: true,
    screenPermission:
      process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "unknown"
  }));

  ipcMain.handle("runtime-desktop:get-screen-permission", async () =>
    process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "unknown"
  );

  ipcMain.handle("runtime-desktop:list-simulators", async () => {
    ensureDarwin();
    return listIOSSimulators();
  });

  ipcMain.handle("runtime-desktop:get-input-permission", async () => {
    ensureDarwin();
    return simulatorInput.getPermission(false);
  });

  ipcMain.handle("runtime-desktop:request-input-permission", async () => {
    ensureDarwin();
    return simulatorInput.getPermission(true);
  });

  ipcMain.on("runtime-desktop:simulator-pointer", (_event, pointer) => {
    if (!selectedCaptureWindowId) return;
    void simulatorInput.sendPointer(selectedCaptureWindowId, pointer).catch(() => {
      // Pointer streaming is best-effort. Permission/setup errors are surfaced by the explicit permission flow.
    });
  });

  ipcMain.handle("runtime-desktop:prepare-simulator-capture", async (_event, udid) => {
    ensureDarwin();

    const devices = await listIOSSimulators();
    const requested =
      (typeof udid === "string" && devices.find((device) => device.udid === udid)) ||
      devices.find((device) => device.state === "Booted") ||
      devices[0];

    if (!requested) {
      throw new Error("No available iOS Simulator devices were found.");
    }

    selectedSimulator = await ensureIOSSimulatorBooted(requested.udid);
    const source = await waitForSimulatorWindow(selectedSimulator.name);
    const windowId = parseDesktopWindowId(source.id);
    if (!windowId) {
      throw new Error(`Simulator capture source "${source.id}" does not expose a macOS window id.`);
    }

    selectedCaptureSourceId = source.id;
    selectedCaptureWindowId = windowId;

    let crop;
    try {
      const reference = await captureIOSSimulatorScreenshot(selectedSimulator.udid);
      crop = await calibrateSimulatorCrop(source.id, reference);
    } catch {
      // Device-only crop is an optimization. Full-window capture remains a valid fallback.
    }

    return {
      device: selectedSimulator,
      source: {
        id: source.id,
        name: source.name,
        windowId
      },
      crop
    };
  });
}

function registerDisplayCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      if (!selectedCaptureSourceId) {
        callback({});
        return;
      }

      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false
      });
      const source = sources.find((item) => item.id === selectedCaptureSourceId);

      if (!source) {
        selectedCaptureSourceId = undefined;
        selectedCaptureWindowId = undefined;
        callback({});
        return;
      }

      callback({ video: source });
    } catch {
      callback({});
    }
  });
}

async function calibrateSimulatorCrop(sourceId, referenceBuffer) {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 180, height: 420 },
    fetchWindowIcons: false
  });
  const source = sources.find((item) => item.id === sourceId);
  if (!source || source.thumbnail.isEmpty()) return undefined;

  const captureImage = source.thumbnail;
  const referenceImage = nativeImage.createFromBuffer(referenceBuffer);
  if (referenceImage.isEmpty()) return undefined;

  const captureSize = captureImage.getSize();
  const referenceSize = referenceImage.getSize();
  const referenceWidth = Math.min(100, referenceSize.width);
  const referenceThumb = referenceImage.resize({ width: referenceWidth });
  const resizedReferenceSize = referenceThumb.getSize();

  return findNormalizedCrop({
    capture: captureImage.toBitmap(),
    captureWidth: captureSize.width,
    captureHeight: captureSize.height,
    reference: referenceThumb.toBitmap(),
    referenceWidth: resizedReferenceSize.width,
    referenceHeight: resizedReferenceSize.height
  });
}

async function waitForSimulatorWindow(deviceName) {
  const deadline = Date.now() + 8_000;
  let lastSources = [];

  while (Date.now() < deadline) {
    lastSources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false
    });

    const source = chooseSimulatorSource(lastSources, deviceName);
    if (source) return source;

    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  const names = lastSources.map((source) => source.name).slice(0, 12).join(", ");
  throw new Error(
    `Could not find the Simulator window for "${deviceName}". Visible windows: ${names || "none"}.`
  );
}

function chooseSimulatorSource(sources, deviceName) {
  const target = deviceName.toLowerCase();

  const scored = sources
    .map((source) => {
      const name = source.name.toLowerCase();
      let score = 0;
      if (name === target) score += 100;
      if (name.includes(target)) score += 60;
      if (name.includes("simulator")) score += 30;
      if (name.includes("iphone") || name.includes("ipad")) score += 10;
      return { source, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.source;
}

function ensureDarwin() {
  if (process.platform !== "darwin") {
    throw new Error("The iOS Simulator desktop adapter currently requires macOS.");
  }
}