# Performance

Performance is central because the tool edits live motion.

## Goals

- keep app at 60 FPS while tuning
- avoid React re-renders for high-frequency controls
- keep patch payloads small
- throttle noisy controls
- support batch patches
- measure latency

## Metrics

- patch round trip
- patch apply time
- dropped frames
- messages per second
- serialized payload size
- memory retained after disconnect

## Recommended approach

- WebSocket for MVP
- JSON messages initially
- throttled controls
- Reanimated SharedValue binding
- schema sent once
- patches only for values

## Future optimization

- MessagePack
- binary transport
- compression
- native transport
- JSI / Nitro bindings where useful
