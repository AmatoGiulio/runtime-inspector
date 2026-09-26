# MVP Roadmap

Current product goal: **make React Native runtime tuning fast enough to feel like part of the normal development loop, while keeping clients interchangeable through one protocol.**

This file is forward-looking. For exact current implementation state, use [implementation-status.md](implementation-status.md).

## Shipped foundation

The foundation is implemented and should be extended rather than replaced:

- protocol 0.3 types, validation, semantic messages, and conformance fixtures;
- local WebSocket broker;
- React Native runtime SDK;
- Web reference panel;
- `panel-core` shared session/value/stale/A-B/export behavior;
- broker schema cache and replay;
- multi-schema runtime sessions and deliberate schema disposal;
- runtime/panel reconnect and stale-schema handling;
- physical-device LAN/Metro discovery, QR output, and explicit broker override;
- per-session panel token and protocol-version enforcement;
- runtime-side control value validation;
- patch throttling and commit semantics;
- trigger/action semantics;
- slider, toggle, color, spring, bezier, and trigger rendering;
- copy-as-code;
- A/B comparison;
- `useInspector`;
- `useRuntimeValue` / `useAction`;
- dev-only `// @inspect` Babel auto-binding;
- MCP client with `get_schema`, `set_control_value`, `batch_set`, and trigger support;
- first Rozenite / React Native DevTools client using the direct Rozenite bridge and the existing RIP model.

## Architecture boundary

Runtime Inspector remains split into three concerns:

1. **Runtime SDK** — declares controls/actions and applies incoming messages to runtime bindings.
2. **Runtime Inspector Protocol** — transport-independent contract and validation.
3. **Clients/transports** — Web + broker, MCP + broker, Rozenite + DevTools bridge.

The Rozenite vertical slice required **zero RIP changes** and reuses `panel-core`. That is the architectural result the previous roadmap was trying to prove.

## Current milestone — v1 release

The DevTools path has been exercised in React Native DevTools on the iOS simulator, and both panels now render one shared DialKit panel. Remaining for a v1 people can try:

1. a short demo: DevTools tuning → Apply to code → an MCP agent tuning the same controls;
2. a physical-device DevTools run;
3. distribution decision (npm vs "clone + pnpm dev"; the CLI currently serves the panel through the workspace Vite dev server).

## Next design topic — timeline

A timeline view (After Effects-style time grid, Ableton-style launchable/looping clips, frame stepping and scrubbing) is the next product direction. It requires the runtime to own animation time rather than only observe it, so it starts as **RFC 0005** — declared clips evaluated as a function of time, transport commands (play/pause/seek/loop) classified in the RIP taxonomy — before any implementation. DialKit 2's timeline module is the candidate renderer.

## Engineering cleanup completed

The runtime WebSocket error handler now guards reentrant errors during close, with a reconnect regression test. Runtime declaration tests use an offline socket so they cannot accidentally open native Node WebSocket connections. The former stack-overflow test failure is resolved.

## Product polish after device validation

Ordered by leverage:

1. **DevTools interaction polish** — only fixes discovered from real Rozenite/device usage; Apply to code from DevTools via Metro is a candidate.
2. **Spring/bezier presentation polish** — richer visualization without moving semantics out of `panel-core`.
3. **Reconnect/diagnostic UX** — clearer transport/session state and actionable failures.
4. **Control density/grouping ergonomics** — improve large schemas without inventing protocol features prematurely.
5. **Demo pass** — one short physical-device flow covering tuning, replay, A/B, copy-as-code, and MCP/agent control.

## DX ladder

Preserve one declaration model regardless of client:

- `useRuntimeValue` / `useAction` — one runtime value/action;
- `useInspector` — grouped/advanced controls;
- explicit binding APIs — full control / non-Reanimated escape hatch;
- `// @inspect` — lowest-friction path for existing SharedValue declarations.

A DevTools client must not require a parallel Rozenite-specific declaration API.

## Architecture watchpoints

Two seams are worth observing rather than refactoring preemptively:

- `panel-core`'s injected transport is still named `WebSocketLike`, even though Rozenite can adapt to it cleanly. A third genuinely different transport may justify a neutral transport interface.
- the runtime direct-client attachment relies on sharing the same runtime module instance as the declarations it observes. Metro/workspace singleton resolution therefore remains important in monorepo development.

Neither point currently justifies a broad rewrite.

## Later, only with evidence

- standalone desktop client;
- VSCode client;
- Nitro/native transport if measured JS transport limits require it;
- recording tooling beyond the timeline RFC above;
- generic plugin system;
- hierarchical addressing if real schemas require it;
- remote collaboration/tunneling;
- production networking/authentication.

## Explicit non-goals now

- no protocol rewrite for Rozenite;
- no Nitro module without a measured bottleneck;
- no desktop app;
- no VSCode extension;
- no recording engine;
- no generic plugin ecosystem;
- no production remote-control networking;
- no monetization work.
