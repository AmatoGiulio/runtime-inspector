# @runtime-inspector/workbench

**Experimental internal workspace package — not published to npm.**

The Runtime Inspector desktop motion Workbench. It combines the shared panel and motion timeline with a macOS development shell. This is an unpackaged developer preview, not a downloadable desktop release.

## Run from source (macOS)

From the [monorepo root](https://github.com/AmatoGiulio/runtime-inspector):

~~~bash
pnpm install
pnpm build
pnpm dev                 # Run the broker in one terminal
pnpm workbench:desktop   # Start the desktop shell in another terminal
~~~

The repository example and desktop commands require an appropriate macOS/Xcode/Simulator environment. Some viewport and input integration uses private Simulator APIs and can break across Xcode versions. Production signing and distribution have not been implemented.

See [Implementation status](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/implementation-status.md) and the [repository README](https://github.com/AmatoGiulio/runtime-inspector).
