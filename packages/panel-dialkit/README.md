# @runtime-inspector/panel-dialkit

**Internal workspace package — not published to npm.**

Shared DialKit-based React rendering for Runtime Inspector's web and Rozenite panels. The package consumes panel state from `@runtime-inspector/panel-core` and provides the common control UI, including sliders, springs, Bézier curves, toggles, colors, and actions.

## Develop in this repository

From the [monorepo root](https://github.com/AmatoGiulio/runtime-inspector):

~~~bash
pnpm install
pnpm build
pnpm --filter @runtime-inspector/panel-web dev
~~~

Changes to this shared renderer can affect both frontends. Run `pnpm verify` before proposing changes. Do not install or publish this package independently.

See [DialKit rendering](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/dialkit.md) and the [repository README](https://github.com/AmatoGiulio/runtime-inspector).
