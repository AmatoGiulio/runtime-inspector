const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("runtimeDesktop", {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke("runtime-desktop:get-info"),
  listSimulators: () => ipcRenderer.invoke("runtime-desktop:list-simulators"),
  prepareSimulatorCapture: (udid) =>
    ipcRenderer.invoke("runtime-desktop:prepare-simulator-capture", udid),
  getScreenPermission: () => ipcRenderer.invoke("runtime-desktop:get-screen-permission"),
  prepareSimulatorInput: () => ipcRenderer.invoke("runtime-desktop:prepare-simulator-input"),
  sendSimulatorPointer: (event) =>
    ipcRenderer.send("runtime-desktop:simulator-pointer", event)
});