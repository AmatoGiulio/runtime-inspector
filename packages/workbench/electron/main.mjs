import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  systemPreferences
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createServer } from "vite";
import {
  captureIOSSimulatorFrame,
  ensureIOSSimulatorBooted,
  listIOSSimulators
} from "./simulator.mjs";
import { parseDesktopWindowId, SimulatorInputHelper } from "./input-helper.mjs";
import { SimulatorFramebufferHelper } from "./framebuffer-helper.mjs";
import { RUNTIME_FRAMEBUFFER_PROFILE } from "./framebuffer-profile.mjs";

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
const simulatorFramebuffer = new SimulatorFramebufferHelper();

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
  await stopFramebufferSession();
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

  ipcMain.handle("runtime-desktop:start-simulator-framebuffer", async (event, udid) => {
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

    let input = { ready: false, error: undefined };
    try {
      await simulatorInput.prepare(selectedSimulator.udid);
      input = { ready: true, error: undefined };
    } catch (error) {
      input = {
        ready: false,
        error: error instanceof Error ? error.message : "Simulator HID input could not be prepared."
      };
    }

    await stopFramebufferSession();

    const sender = event.sender;

    // Capture one exact framebuffer before starting the persistent helper.
    // Do NOT emit it over the streaming event yet: the renderer's framebuffer
    // canvas is mounted only after this IPC request resolves, so an eager event
    // can be received and discarded before there is a canvas to draw into.
    let bootstrapFrame;
    try {
      const bootstrap = await captureIOSSimulatorFrame(selectedSimulator.udid, "jpeg");
      const bootstrapImage = nativeImage.createFromBuffer(bootstrap);
      const bootstrapSize = bootstrapImage.getSize();

      if (!bootstrapImage.isEmpty() && bootstrapSize.width > 0 && bootstrapSize.height > 0) {
        const now = Date.now();
        bootstrapFrame = {
          sequence: 0,
          capturedAtMs: now,
          receivedAtMs: now,
          encodeDurationUs: 0,
          width: bootstrapSize.width,
          height: bootstrapSize.height,
          mimeType: "image/jpeg",
          bytes: Uint8Array.from(bootstrap).buffer
        };
      }

      // Give CoreSimulator a short turn to publish the display surface after
      // the bootstrap capture before the persistent helper resolves ioPorts.
      await new Promise((resolve) => setTimeout(resolve, 80));
    } catch {
      // Bootstrap is best-effort. The persistent helper still owns the live path.
    }

    await simulatorFramebuffer.start({
      udid: selectedSimulator.udid,
      fps: 60,
      width: RUNTIME_FRAMEBUFFER_PROFILE.width,
      quality: RUNTIME_FRAMEBUFFER_PROFILE.quality,
      pollIntervalUs: RUNTIME_FRAMEBUFFER_PROFILE.pollIntervalUs,
      onFrame: (frame) => {
        if (sender.isDestroyed()) return;
        sender.send("runtime-desktop:simulator-framebuffer-frame", {
          sequence: frame.sequence,
          capturedAtMs: frame.capturedAtMs,
          receivedAtMs: frame.receivedAtMs,
          encodeDurationUs: frame.encodeDurationUs,
          width: frame.width,
          height: frame.height,
          mimeType: frame.mimeType,
          bytes: Uint8Array.from(frame.bytes).buffer
        });
      },
      onError: (error) => {
        if (sender.isDestroyed()) return;
        sender.send("runtime-desktop:simulator-framebuffer-error", {
          message:
            error instanceof Error
              ? error.message
              : "The persistent Simulator framebuffer helper failed."
        });
      }
    });

    return {
      device: selectedSimulator,
      mode: "iosurface-mjpeg",
      targetFrameRate: 60,
      input,
      bootstrapFrame
    };
  });

  ipcMain.handle("runtime-desktop:stop-simulator-framebuffer", async () => {
    await stopFramebufferSession();
    return true;
  });

  ipcMain.handle("runtime-desktop:prepare-simulator-input", async () => {
    ensureDarwin();
    if (!selectedSimulator) {
      throw new Error("Attach an iOS Simulator before preparing input.");
    }
    await simulatorInput.prepare(selectedSimulator.udid);
    return true;
  });

  ipcMain.on("runtime-desktop:simulator-pointer", (_event, pointer) => {
    if (!selectedSimulator) return;
    void simulatorInput.sendPointer(selectedSimulator.udid, pointer).catch((error) => {
      console.error("[Runtime Inspector] Simulator HID input failed:", error);
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

    // Window capture is retained only as the stable fallback while the direct
    // CoreSimulator framebuffer adapter is implemented. Do not crop or map
    // input against Simulator chrome: the window is not the iOS framebuffer.
    const crop = undefined;

    let input = { ready: false, error: undefined };
    try {
      await simulatorInput.prepare(selectedSimulator.udid);
      input = { ready: true, error: undefined };
    } catch (error) {
      input = {
        ready: false,
        error: error instanceof Error ? error.message : "Simulator HID input could not be prepared."
      };
    }

    return {
      device: selectedSimulator,
      source: {
        id: source.id,
        name: source.name,
        windowId
      },
      crop,
      input
    };
  });
}

async function stopFramebufferSession() {
  await simulatorFramebuffer.stop();
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