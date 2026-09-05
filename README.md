# Vanguard Memory Node (VMN)

[![npm version](https://img.shields.io/npm/v/%40lnes%2Fvanguard-memory-node.svg)](https://www.npmjs.com/package/@lnes/vanguard-memory-node)
[![npm downloads](https://img.shields.io/npm/dm/%40lnes%2Fvanguard-memory-node.svg)](https://www.npmjs.com/package/@lnes/vanguard-memory-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![MCP Badge](https://lobehub.com/badge/mcp/ezumba-vanguard-memory-node)](https://lobehub.com/mcp/ezumba-vanguard-memory-node)

Local deterministic memory for AI agents via the Model Context Protocol (MCP).

No cloud. No vector database. No semantic drift. Your data stays on your machine.

---

## What it does

VMN gives any MCP-compatible AI agent a persistent, queryable memory vault stored entirely on local disk. Text is ingested once, content-addressed with SHA-256, segmented, and indexed with a sharded BM25 inverted index. Retrieval is deterministic: the same query always returns the same ranked result from the same data.

Optionally, vaults can be synced to the [ExergyNet LNES-17 ledger](https://exergynet.org) for cross-device and cross-agent recall with cryptographic provenance.

---

## Install

```bash
npm install -g @lnes/vanguard-memory-node
```

Or run without installing:

```bash
npx @lnes/vanguard-memory-node
```

---

## Claude Desktop integration

**Mac** — `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"]
    }
  }
}
```

With ExergyNet vault sync enabled:

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "npx",
      "args": ["-y", "@lnes/vanguard-memory-node"],
      "env": {
        "EXERGYNET_API_KEY": "sk-exergy-your-key",
        "EXERGYNET_NETWORK": "mainnet",
        "AUTO_SYNC_VAULT": "true"
      }
    }
  }
}
```

WSL on Windows:

```json
{
  "mcpServers": {
    "vanguard-memory": {
      "command": "wsl",
      "args": ["-d", "Ubuntu", "npx", "-y", "@lnes/vanguard-memory-node"]
    }
  }
}
```

---

## Tools (11 total)

### `vmn_ingest`
Stores text as a SHA-256 content-addressed shard. Segments it, indexes it, and updates the local catalog.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Content to store |
| `title` | string | no | Human-readable label |
| `namespace` | string | no | Logical partition (default: `default`) |
| `tags` | string[] | no | Search tags |
| `content_type` | string | no | MIME type hint (default: `text/plain`) |
| `source` | string | no | Source label |

Returns: SHA-256 root hash + vault path + `vault_synced` flag.

### `vmn_recall`
Retrieves a 900-character evidence window from a specific shard using lexical BM25 scoring.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hash` | string | yes | Root hash from `vmn_ingest` |
| `query` | string | yes | Search query |

Returns: best-matching evidence window, or a human-readable no-match message.

### `vmn_search`
Full-vault keyword search across all ingested objects. Returns ranked results with snippets.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query |
| `limit` | number | no | Max results (default: 10) |
| `namespace` | string | no | Restrict search to this namespace only |

### `vmn_ingest_file`
Delta-ingests a growing file into the vault, tracking progress with a cursor so only new lines are ingested on each call. Designed for Stop hooks and continuous log pipelines — safe to call repeatedly with no duplicates.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Absolute path to the file |
| `session_id` | string | no | Cursor key (defaults to file path) |
| `namespace` | string | no | Namespace for ingested content (default: `file_ingest`) |
| `title` | string | no | Optional title override |
| `tags` | string[] | no | Optional tags |

Returns: `lines_ingested`, `cursor_line`, and shard `hash` (null if no new content).

**Stop hook example** — ingest every Claude session automatically:

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "npx -y @lnes/vanguard-memory-node vmn_ingest_file --file_path \"$CLAUDE_SESSION_FILE\" --session_id \"$CLAUDE_SESSION_ID\""
      }]
    }]
  }
}
```

### `vmn_list`
Lists all memory objects in the vault.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `namespace` | string | no | Filter by namespace |

### `vmn_inspect`
Returns full catalog metadata for a specific object.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hash` | string | yes | Root hash |

### `vmn_delete`
Permanently removes an object and all its index entries.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `hash` | string | yes | Root hash |

### `vmn_stats`
Returns aggregate vault statistics: entry count, total bytes, namespaces, oldest/newest timestamps.

### `vmn_index_status`
Returns current BM25 index state (`READY`, `REBUILD_REQUIRED`, `REBUILDING`, `DEGRADED`).

### `vmn_rebuild_index`
Rebuilds the full BM25 index from authoritative object files. Safe at any time — objects are never modified.

### `vmn_sync_vault`
Syncs a local memory object to the ExergyNet LNES-17 vault. Requires `EXERGYNET_API_KEY`. Use `EXERGYNET_NETWORK` to target mainnet or testnet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `xlmp_root` | string | yes | Root hash of the object to sync |
| `intent` | string | no | Sync intent label (default: `manual-sync`) |

Returns: `xlmp_root`, `bytes_committed`, `status`, and the resolved vault URL.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AUTO_SYNC_VAULT` | `false` | Set to `true` to auto-sync every `vmn_ingest` to ExergyNet |
| `EXERGYNET_API_KEY` | — | API key for ExergyNet vault access (`sk-exergy-*`) |
| `EXERGYNET_NETWORK` | `testnet` | Target substrate: `mainnet` → `portal.exergynet.org`, `testnet` → `dt.portal.exergynet.org` |
| `EXERGYNET_VAULT_URL` | _(resolved from `EXERGYNET_NETWORK`)_ | Override vault base URL entirely |

---

## Vault layout

```
~/.vanguard/
├── local_vault/
│   └── <sha256>.txt              # authoritative object files (never modified after write)
├── catalog/
│   └── <sha256>.json             # per-object metadata (O(1) reads)
├── segments/
│   └── <sha256>.json             # segment records with term frequencies
├── cursors/
│   └── <session_id>.json         # cursor state for vmn_ingest_file
└── index/
    └── v2/
        ├── index_manifest.json   # version + state header
        ├── corpus_stats.json     # BM25 corpus statistics
        └── postings/
            └── <2-hex>.json      # 256 sharded posting buckets
```

---

## How retrieval works

1. **Normalization** — Unicode NFC → phrase alias substitution → tokenize → suffix stem → stop-word filter → token alias expansion
2. **Stemmer** — 13-rule suffix stripper: `tions→` (5), `ions→` (4), `tion→` (4), `ings→` (4), `ing→` (3), `ers→` (3), `ies→` (3), `ic→` (2), `er→` (2), `ed→` (2), `es→` (2), `s→` (1), `y→` (1). Rules applied longest-first; `medications` and `medication` both reduce to the same root.
3. **Alias expansion** — clinical, technical, and legal synonym clusters (`smok↔tobacco↔cigarett`, `physician↔doctor`, `hypertens↔bp`, etc.)
4. **BM25 scoring** — sharded 256-bucket inverted index; top-150 postings per term to cap high-DF stall
5. **Fallback** — stemmed-token set comparison when BM25 score is zero; prevents false positives on partial-word matches

---

## Comparison

| | VMN | ChromaDB / Pinecone |
|---|---|---|
| Result determinism | Same query → same result, always | Varies with model version |
| Data location | Local disk only | Cloud upload required |
| Per-query cost | $0 | API charges |
| Setup time | 60 seconds | Account + key + SDK |
| Semantic drift | None | Breaks on model updates |
| Offline capable | Yes | No |

---

## License

MIT — free forever, no telemetry, no usage limits.

Built by [ExergyNet](https://exergynet.org).
