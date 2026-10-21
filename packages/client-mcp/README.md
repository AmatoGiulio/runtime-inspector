# @runtime-inspector/client-mcp

An [MCP](https://modelcontextprotocol.io/) server that lets a compatible AI client read and tune controls exposed by a running [Runtime Inspector](https://github.com/AmatoGiulio/runtime-inspector) app.

## Install and run

Start `npx runtime-inspector dev` from the app root (after installing the CLI and SDK as described in [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md)). Then configure your MCP client to launch:

~~~bash
npx -y @runtime-inspector/client-mcp@alpha
~~~

For clients that use a JSON `mcpServers` map, an example entry is:

~~~json
{
  "mcpServers": {
    "runtime-inspector": {
      "command": "npx",
      "args": ["-y", "@runtime-inspector/client-mcp@alpha"]
    }
  }
}
~~~

Your MCP client's actual configuration format may differ. On startup the server uses the CLI session file at `~/.runtime-inspector/session.json` to locate the broker. Explicit `RI_BROKER_URL` and `RI_TOKEN` environment variables override automatic discovery.

## Available tools

- `get_schema` — inspect exposed controls and current values.
- `set_control_value` — update one control.
- `batch_set` — validate and apply multiple values.
- `trigger` — run an exposed action.
- `list_scenes` and `open_scene` — inspect and replay available motion scenes.

Use `get_schema` before editing values. This client tunes the running app; **Apply to code** is handled by the web panel, not by an MCP tool.

Only connect trusted MCP clients to your local development broker. Session tokens grant control of the running app.

## Links

[Repository](https://github.com/AmatoGiulio/runtime-inspector) · [Getting started](https://github.com/AmatoGiulio/runtime-inspector/blob/main/docs/getting-started.md) · [Issues](https://github.com/AmatoGiulio/runtime-inspector/issues)

**Status:** alpha, APIs may change. MIT license.
