# Vanguard Memory Node (VMN)

Local deterministic memory for AI agents via the Model Context Protocol (MCP).

No cloud. No vector database. No semantic drift. Your data stays on your NVMe.

## How it works

VMN uses xLMP (Logical Memory Protocol) — a deterministic, content-addressed memory substrate. It shatters text into fixed shards and retrieves evidence using lexical keyword density scoring, not probabilistic cosine similarity.

## Install

```
npm install -g vanguard-memory-node
```

## Claude Desktop Integration

Add to your `claude_desktop_config.json`:

### Mac
`~/Library/Application Support/Claude/claude_desktop_config.json`

### Windows
`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "node",
      "args": ["/path/to/vanguard_memory_node/dist/index.js"]
    }
  }
}
```

For WSL on Windows:
```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "wsl",
      "args": ["-d", "Ubuntu", "node", "/home/edt/vanguard_memory_node/dist/index.js"]
    }
  }
}
```

## Tools

### vmn_ingest
Stores text locally as a SHA-256 addressed shard.
- Input: `text` (string)
- Returns: SHA-256 hash

### vmn_recall
Retrieves evidence from a shard using deterministic xLMP lexical search.
- Input: `hash` (string), `query` (string)
- Returns: bounded evidence window

## Local vault

```
~/.vanguard/local_vault/<hash>.txt
```

## Built by ExergyNet
https://exergynet.org
