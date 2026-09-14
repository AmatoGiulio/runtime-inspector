# MVP Roadmap

Current product goal: **make React Native runtime tuning fast enough to feel like part of the normal development loop**, on a physical device, with a protocol that can power more than one client.

The original summer success metric still holds as a useful bar: from `runtime-inspector dev` to a working control on a real device in about 60 seconds, zero-config in the common Expo/RN case.

## Shipped foundation

The original MVP loop is implemented and hardened enough that the next work should build on it rather than replace it:

- Monorepo package structure.
- Protocol types, validation, and conformance fixtures.
- Local WebSocket broker.
- React Native runtime SDK.
- Web reference panel.
- Expo/Reanimated example.
- Broker schema cache and replay.
- Runtime and panel reconnect behavior.
- Physical-device LAN support with Metro-host discovery and fallback candidates.
- Per-session panel token and protocol-version enforcement.
- Runtime-side value validation.
- Explicit stale-schema/runtime status.
- Patch throttling and commit semantics.
- Trigger controls for actions such as replaying a transition.
- Copy-as-code export.
- A/B compare with batch application and replay.
- Slider, toggle, color, spring, bezier, and trigger controls.
- `panel-core` extracted from the web UI so clients can share session logic.
- Protocol 0.3 semantic messages: `control.trigger`, `control.commit`, `schema.dispose`, stale runtime behavior.
- Multi-schema-safe runtime sessions.
- Dev-only `// @inspect` Babel auto-binding.
- `useRuntimeValue` and `useAction` Runtime Value APIs.
- MCP client for AI-agent control (`get_schema`, `set_control_value`, `batch_set`, `trigger`).

## Current architecture boundary

The architecture is now intentionally split into three layers:

1. **Runtime SDK** — declares controls and applies incoming values/actions.
2. **Runtime Inspector Protocol** — the stable contract between runtime and clients.
3. **Clients** — web panel today, MCP agent client today, React Native DevTools/Rozenite next.

That boundary matters: the next milestone should validate the interchangeable-client design instead of adding another parallel control system.

## Next milestone — React Native DevTools / Rozenite

Build a Rozenite plugin on top of `panel-core` and the existing protocol.

Goals:

- surface Runtime Inspector directly inside React Native DevTools;
- reuse the same schema/value/trigger semantics as the web panel;
- preserve A/B compare, commits, stale state, and export behavior where they make sense in the DevTools host;
- keep the web panel as a reference/standalone client rather than making it a dependency;
- prove that the protocol is genuinely client-agnostic.

This integration is **planned, not shipped yet**.

## Product polish after the DevTools client

Ordered by leverage:

1. **Spring editor polish** — improve the visualization and interaction beyond the current first-pass editor.
2. **Reconnect/diagnostic UX** — make retry/backoff state and discovery failures more visible and actionable.
3. **Control presentation metadata** — improve density, grouping, labels, and more complex panel schemas without changing protocol fundamentals unnecessarily.
4. **Color/value ergonomics** — expand formats only where real usage justifies it.
5. **Physical-device demo pass** — demonstrate live tuning by feel, replay, A/B, copy-as-code, and agent-driven control in one short flow.

## MCP / agent direction

The MCP client is already implemented and connects as an ordinary panel-role client over the same broker. It can:

- inspect available schemas;
- set a single control value;
- apply a batch of values;
- trigger runtime actions;
- respect stale runtime state.

The important claim is not that agent control is unique. The useful property is that **agents and human-facing panels use the same runtime contract**, so improvements to the protocol benefit both.

## DX ladder

Runtime Inspector currently offers multiple entry points onto the same Runtime Value model:

- `// @inspect` — lowest ceremony for an existing `useSharedValue`;
- `useRuntimeValue` / `useAction` — one-line runtime values/actions;
- `useInspector` — grouped declarative panels with richer metadata and callbacks;
- explicit binding APIs — full control / non-Reanimated escape hatch.

Future work should preserve this ladder instead of introducing a separate DevTools-only declaration API.

## Later

Only after the current protocol + Rozenite path proves itself in real use:

- standalone desktop client;
- VSCode client;
- native/Nitro transport path if measured JS transport limits justify it;
- recording/timeline tooling;
- plugin system;
- hierarchical control addressing (`control.path`) if real schemas require it;
- designer/dev remote collaboration via tunnel;
- production networking/authentication.

## Explicit non-goals for the current milestone

- no protocol rewrite just to fit Rozenite;
- no Nitro module without a measured bottleneck;
- no desktop app;
- no VSCode extension;
- no recording engine;
- no general plugin ecosystem;
- no production remote-control networking.

The immediate test is simpler: **can the existing Runtime Inspector model feel native inside React Native DevTools without weakening the protocol-first architecture?**
