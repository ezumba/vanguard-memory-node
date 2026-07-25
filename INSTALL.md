# Vanguard Memory Node (VMN)

Local deterministic memory for AI agents via MCP.

## Install
npm install
npm run build

## Claude Desktop Integration
Add to ~/Library/Application Support/Claude/claude_desktop_config.json (Mac)
or %APPDATA%\Claude\claude_desktop_config.json (Windows):

{
  "mcpServers": {
    "vanguard-memory": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/vanguard_memory_node/dist/index.js"]
    }
  }
}

## Tools
- vmn_ingest: Store text locally, returns SHA-256 shard hash
- vmn_recall: Retrieve evidence from shard using deterministic xLMP search

## Local vault location
~/.vanguard/local_vault/
