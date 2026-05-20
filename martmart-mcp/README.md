# MartMart MCP extension for pi

Global pi extension that mirrors MartMart MCP tools into pi custom tools.

## What it does

- auto-discovers MartMart MCP tools from `martmart mcp`
- registers them in pi under the same names, e.g. `session_status`, `products_search`, `cart_add`
- keeps a long-lived local MCP subprocess over stdio
- adds:
  - `/martmart-mcp-status`
  - `/martmart-mcp-restart`

## Installation

This extension is installed as an auto-discovered global extension at:

```text
~/.pi/agent/extensions/martmart-mcp/index.ts
```

No `settings.json` entry is needed.

## Binary resolution

The extension tries these options in order:

1. `MARTMART_MCP_COMMAND`
2. `martmart` on `PATH`
3. `~/dev/martmart-cli/martmart`
4. `~/dev/martmart-cli/bin/martmart`
5. `./martmart`
6. `./bin/martmart`

Optional overrides:

```bash
export MARTMART_MCP_COMMAND="$HOME/dev/martmart-cli/martmart mcp"
export MARTMART_MCP_CWD="$HOME/dev/martmart-cli"
```

## Reload

If pi is already running, use:

```text
/reload
```

New pi sessions should discover it automatically.

## Notes

- Tool names mirror MartMart MCP exactly.
- The extension only registers newly discovered tools; if MartMart adds more tools later, use `/martmart-mcp-restart` or `/reload`.
- This only affects pi sessions that load extensions. It does not retroactively change already-created external API harness tool lists.
