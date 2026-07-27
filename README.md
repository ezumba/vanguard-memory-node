# Vanguard Memory Node (VMN) v1.1.0

Local deterministic memory for AI agents via the Model Context Protocol (MCP).

No cloud. No vector database. No semantic drift. Your data stays on your NVMe.

## How it works

VMN uses xLMP (Logical Memory Protocol) — a deterministic, content-addressed memory substrate. It shatters text into fixed shards and retrieves evidence using lexical keyword density scoring, not probabilistic cosine similarity.

Chunks are split hierarchically: paragraph → sentence → word → hard 1800-char ceiling. Retrieval uses suffix-aware stemming so `smoking` matches `smoker` and vice versa.

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

## Tools (7 total)

### vmn_ingest
Stores text locally as a SHA-256 content-addressed shard. Updates catalog metadata.
- Input: `text` (string, required), `title` (optional), `namespace` (optional, default: "default"), `tags` (optional string[]), `content_type` (optional), `source` (optional)
- Returns: SHA-256 hash + storage path

### vmn_recall
Retrieves evidence from a shard using deterministic xLMP lexical search.
- Input: `hash` (string), `query` (string)
- Returns: bounded 900-char evidence window centered on highest-density keyword match

### vmn_list
Lists all memory objects in the vault, with optional namespace filter.
- Input: `namespace` (optional string)
- Returns: table of root hash, title, segment count, date

### vmn_search
Full-vault keyword search across titles, excerpts, and tags. Returns candidate roots ranked by score.
- Input: `query` (string), `limit` (optional number, default 10)
- Returns: ranked list of matching objects with excerpt and score

### vmn_inspect
Returns full catalog metadata for a specific memory object by hash.
- Input: `hash` (string)
- Returns: JSON catalog entry (root, title, namespace, tags, content_type, source, segment_count, byte_size, excerpt, ingested_at, updated_at)

### vmn_delete
Permanently deletes a memory object from vault and catalog.
- Input: `hash` (string)
- Returns: confirmation or not-found message

### vmn_stats
Returns aggregate statistics about the local vault.
- Returns: total_entries, total_bytes, namespaces, oldest_at, newest_at

## Local vault

```
~/.vanguard/local_vault/<hash>.txt    # shard content
~/.vanguard/local_vault/catalog.json  # catalog index
```

## Built by ExergyNet
https://exergynet.org
