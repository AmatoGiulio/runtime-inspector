# Transport Layer

The protocol is transport-agnostic.

The first implementation should use local WebSocket.

## Why WebSocket first

- simple
- fast enough
- works with web panel
- easy debugging
- no native code required
- supports bidirectional messages

## Topology options

### Runtime as server

The app opens a WebSocket server.

Pros:
- direct connection
- simple mental model

Cons:
- mobile platform limitations
- permissions/network constraints

### External dev server as broker

A local Node server sits between panel and runtime.

```txt
Panel Web <-> Local Broker <-> React Native App
```

Pros:
- easier for web panel
- easier discovery
- can support multiple runtimes
- can persist sessions

Cons:
- one extra process

## MVP recommendation

Use a local broker.

The React Native app connects outbound to the broker.
The web panel connects to the same broker.
This avoids making the phone host a server.
