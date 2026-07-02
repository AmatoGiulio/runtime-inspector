# Local Broker

The local broker is a small Node process.

## Responsibilities

- accept runtime connections
- accept panel connections
- route messages
- keep session registry
- expose web panel
- optionally persist recordings
- optionally provide QR code connection

## Ports

Default:

```txt
Runtime WebSocket: ws://localhost:4877/runtime
Panel WebSocket:   ws://localhost:4877/panel
Panel UI:          http://localhost:4878
```

## Mobile device connection

For a real device on the same Wi-Fi, the app connects to the development machine IP.

For Android emulator, use `10.0.2.2`.

For iOS simulator, use `localhost`.

## Future

- ADB reverse setup
- Expo CLI integration
- Metro middleware
- Bonjour discovery
