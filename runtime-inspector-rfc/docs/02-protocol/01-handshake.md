# Handshake

The handshake establishes compatibility between client and runtime.

## Client hello

```json
{
  "rip": "1.0",
  "type": "handshake.hello",
  "timestamp": 1720000000000,
  "payload": {
    "client": {
      "id": "panel-web",
      "name": "Runtime Inspector Web Panel",
      "version": "0.1.0"
    },
    "supportedProtocolVersions": ["1.0"],
    "capabilities": {
      "recording": true,
      "presetExport": true,
      "customControls": true
    }
  }
}
```

## Runtime accept

```json
{
  "rip": "1.0",
  "type": "handshake.accept",
  "sessionId": "ses_123",
  "timestamp": 1720000000100,
  "payload": {
    "runtime": {
      "id": "rn-ios-iphone-15",
      "name": "NMP Dev App",
      "platform": "ios",
      "framework": "react-native",
      "version": "0.1.0"
    },
    "protocolVersion": "1.0",
    "capabilities": {
      "patch": true,
      "batchPatch": true,
      "recording": false,
      "binary": false
    }
  }
}
```

## Rejection

Runtime rejects when:

- protocol version is unsupported
- authentication fails
- runtime is not in development mode
- schema registry is disabled
