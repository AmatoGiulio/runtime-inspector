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

## Current milestone — validate the DevTools path on a real device

The Rozenite client is now implemented in code and covered by automated bridge/session tests. The next milestone is no longer “build Rozenite”; it is **prove the complete graphical DevTools path in real use**.

Highest-value validation:

1. run the existing Expo/Reanimated example with Rozenite enabled;
2. open the Runtime Inspector tab in React Native DevTools;
3. verify multiple schemas and live/stale state;
4. tune slider/toggle/color/spring/bezier values on a physical device;
5. verify patch during interaction and commit at the end;
6. fire replay/trigger actions;
7. reload Metro/app and verify stale → republished recovery;
8. exercise A/B and copy-as-code from DevTools.

Do not add new product surfaces until this path has been exercised and any actual integration friction is known.

## Immediate engineering cleanup

The repository baseline currently exposes a separate test-harness problem in the React Native WebSocket path: some fake WebSocket error flows recurse through `onerror -> close() -> onerror` until stack overflow. Build/typecheck are not blocked by it, and Rozenite/direct-runtime targeted tests are independent, but the global test gate should be restored to green as a focused cleanup.

This is higher priority than speculative refactoring because it restores trustworthy whole-repository verification.

## Product polish after device validation

Ordered by leverage:

1. **DevTools interaction polish** — only fixes discovered from real Rozenite/device usage.
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
- recording/timeline tooling;
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
