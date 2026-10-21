# @runtime-inspector/cli

Command-line setup and local development server for [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector). The CLI runs the WebSocket broker, serves the web panel, and handles supported **Apply to code** requests.

## Install in your app

~~~bash
npm install @runtime-inspector/react-native@alpha
npm install --save-dev @runtime-inspector/babel-plugin@alpha @runtime-inspector/cli@alpha
~~~

## Commands

~~~bash
npx runtime-inspector init --dry-run  # Preview configuration edits
npx runtime-inspector init            # Configure Babel and Metro
npx runtime-inspector dev             # Start broker, web panel and source write-back
~~~

Run the CLI from your **React Native app root** so source write-back points at the correct files. If you run it elsewhere, set `RUNTIME_INSPECTOR_WORKSPACE_ROOT` to the app root.

`init` does not install dependencies for you; it reports missing packages and manual steps for configuration shapes it cannot edit safely. Once `dev` is running, launch your app (for example `npx expo start`) and open the URL printed in the terminal.

Default ports: `4577` for the broker and `4600` for the web panel. Change them with `RUNTIME_INSPECTOR_PORT` and `RUNTIME_INSPECTOR_PANEL_PORT`.

The CLI also writes a local session file (normally `~/.runtime-inspector/session.json`) for the Workbench and MCP client. It is removed on normal shutdown; `RUNTIME_INSPECTOR_HOME` overrides its directory.

**Security:** use the broker only on a trusted development network. The URL contains a bearer-like session token that permits tuning and potentially writing to your app's source files. Do not share it.

The executable is named `runtime-inspector`, but an unrelated npm package uses that name. Install **@runtime-inspector/cli** locally before running the commands above.

## Links

[Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [Repository](https://github.com/AmatoGiulio/runtime-inspector) · [Issues](https://github.com/AmatoGiulio/runtime-inspector/issues)

**Status:** alpha, APIs may change. MIT license.
