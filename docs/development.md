# Development

Test the plugin locally in the Claude Code CLI:

```shell
CLAUDE_PLUGIN_ROOT=$(pwd) claude --plugin-dir . --mcp-config ./.mcp.dev.json --debug
```

Notable options:
  * `--mcp-config ./.mcp.dev.json` - loads the MCP using a environment vars, rather than User Config keys that aren't
    supported when running the plugin locally
  * `--debug` - writes out logs that can be inspected if there is a problem

## Run with 1Password CLI

During development if you don't want the .env to contain secrets then 1Password's CLI can be used to
expand a placeholder:

```shell
CLAUDE_PLUGIN_ROOT=$(pwd) op run --env-file='./.env' --no-masking -- claude --plugin-dir . --debug --mcp-config ./.mcp.dev.json
```

Notable options:
 * `--no-masking` - By default `op run` pipes the child's stdio to redact secrets, which makes Claude think it is being
   scripted. This option prevents the redaction piping.


To aid in the development of the MCP server install the MCP Server Skill:

```
npx skills add https://github.com/anthropics/claude-plugins-official/tree/main/plugins/mcp-server-dev/skills/build-mcp-server
```

Claude Code plugin for developing plugins

https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev

## Claude Desktop

Logs for Claude Desktop can be found: `~/Library/Logs/Claude/claude.ai-web.log`
