# Runtime Lifecycle

## 1. App starts

In development mode, the Runtime SDK initializes.

## 2. Panels register

Code calls `definePanel()` or `registerPanel()`.

## 3. Transport starts

The runtime opens a local WebSocket server or connects to a known local server.

## 4. Client discovers runtime

The panel client finds the runtime through manual URL entry, QR code, local discovery or Metro integration.

## 5. Handshake

Client and runtime exchange protocol versions and capabilities.

## 6. Schema sync

Runtime sends panel schemas and current values.

## 7. Live editing

Client sends patch messages. Runtime applies patches.

## 8. Preset export

Client requests current values. Runtime returns serializable preset data.

## 9. Session closes

Client disconnects. Runtime may continue running or stop the dev server.
