const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("runtimeDesktop", {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke("runtime-desktop:get-info"),
  listSimulators: () => ipcRenderer.invoke("runtime-desktop:list-simulators"),
  prepareSimulatorCapture: (udid) =>
    ipcRenderer.invoke("runtime-desktop:prepare-simulator-capture", udid),
  startSimulatorFramebuffer: (udid) =>
    ipcRenderer.invoke("runtime-desktop:start-simulator-framebuffer", udid),
  stopSimulatorFramebuffer: () =>
    ipcRenderer.invoke("runtime-desktop:stop-simulator-framebuffer"),
  onSimulatorFramebufferFrame: (callback) => {
    const handler = (_event, frame) => callback(frame);
    ipcRenderer.on("runtime-desktop:simulator-framebuffer-frame", handler);
    return () => ipcRenderer.removeListener("runtime-desktop:simulator-framebuffer-frame", handler);
  },
  onSimulatorFramebufferStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("runtime-desktop:simulator-framebuffer-status", handler);
    return () => ipcRenderer.removeListener("runtime-desktop:simulator-framebuffer-status", handler);
  },
  onSimulatorFramebufferError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("runtime-desktop:simulator-framebuffer-error", handler);
    return () => ipcRenderer.removeListener("runtime-desktop:simulator-framebuffer-error", handler);
  },
  getScreenPermission: () => ipcRenderer.invoke("runtime-desktop:get-screen-permission"),
  prepareSimulatorInput: () => ipcRenderer.invoke("runtime-desktop:prepare-simulator-input"),
  sendSimulatorPointer: (event) =>
    ipcRenderer.send("runtime-desktop:simulator-pointer", event)
});