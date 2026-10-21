# @runtime-inspector/panel-web

**Internal workspace package — not published to npm.**

Vite/React web frontend for Runtime Inspector. It renders the shared DialKit panel with `panel-core` session behavior, and is bundled into the published `@runtime-inspector/cli` distribution.

## Develop in this repository

From the [monorepo root](https://github.com/AmatoGiulio/runtime-inspector):

~~~bash
pnpm install
pnpm build
pnpm dev
~~~

`pnpm dev` starts the broker and web panel for the example app. The published installation path is **@runtime-inspector/cli**, not this internal package. To test the UI in isolation, use `pnpm --filter @runtime-inspector/panel-web dev` and point it at a running development broker.

See [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) and the [repository README](https://github.com/AmatoGiulio/runtime-inspector).
