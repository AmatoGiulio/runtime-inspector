const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("runtimeDesktop", {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke("runtime-desktop:get-info"),
  listSimulators: () => ipcRenderer.invoke("runtime-desktop:list-simulators"),
  prepareSimulatorCapture: (udid) =>
    ipcRenderer.invoke("runtime-desktop:prepare-simulator-capture", udid),
  getScreenPermission: () => ipcRenderer.invoke("runtime-desktop:get-screen-permission"),
  getInputPermission: () => ipcRenderer.invoke("runtime-desktop:get-input-permission"),
  requestInputPermission: () => ipcRenderer.invoke("runtime-desktop:request-input-permission"),
  sendSimulatorPointer: (event) =>
    ipcRenderer.send("runtime-desktop:simulator-pointer", event)
});