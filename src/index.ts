#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ingest_text,
  retrieve_evidence,
  list_vault,
  search_vault,
  inspect_entry,
  delete_entry,
  vault_stats,
  get_index_status,
  rebuild_index,
  ingest_file_delta,
} from './core.js';
import { syncToVault, readVaultObject } from './vault_bridge.js';

const server = new McpServer({
  name: 'vanguard-memory-node',
  version: '1.5.0',
});

server.tool(
  'vmn_ingest',
  'Ingest text into the local Vanguard Memory Vault. Returns a SHA-256 shard hash.',
  {
    text: z.string().describe('The text content to ingest and shard locally'),
    title: z.string().optional().describe('Optional human-readable title'),
    namespace: z.string().optional().describe('Optional namespace (default: "default")'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
    content_type: z.string().optional().describe('Optional content type (default: "text/plain")'),
    source: z.string().optional().describe('Optional source label')
  },
  async ({ text, title, namespace, tags, content_type, source }) => {
    const hash = ingest_text(text, { title, namespace, tags, content_type, source });
    let vaultSynced = false;
    if (process.env.AUTO_SYNC_VAULT === 'true') {
      const r = await syncToVault(text, 'auto-sync');
      vaultSynced = r.status === 'ok';
    }
    return {
      content: [{
        type: 'text',
        text: `INGESTED. Local shard hash: ${hash}\nStored at: ~/.vanguard/local_vault/${hash}.txt\nvault_synced: ${vaultSynced}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
      }]
    };
  }
);

server.tool(
  'vmn_recall',
  'Recall evidence from a local Vanguard Memory shard using deterministic xLMP lexical search.',
  {
    hash: z.string().describe('The SHA-256 shard hash returned by vmn_ingest'),
    query: z.string().describe('The query to search within the shard')
  },
  async ({ hash, query }) => {
    const evidence = retrieve_evidence(hash, query);
    const text = evidence === 'no_relevant_evidence_found'
      ? `No relevant evidence found in local memory for query: "${query}".`
      : evidence;
    return {
      content: [{
        type: 'text',
        text: `${text}\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY | network_verification_available=false`
      }]
    };
  }
);

server.tool(
  'vmn_list',
  'List all memory objects in the local vault. Optionally filter by namespace.',
  {
    namespace: z.string().optional().describe('Optional namespace filter')
  },
  async ({ namespace }) => {
    const entries = list_vault(namespace);
    if (entries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No entries found${namespace ? ` in namespace: ${namespace}` : ''}.\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
        }]
      };
    }
    const lines = entries.map(e =>
      `${e.root.slice(0, 16)}... | ${e.title} | ${e.segment_count} segments | ${e.updated_at.slice(0, 10)}`
    ).join('\n');
    return {
      content: [{
        type: 'text',
        text: `Found ${entries.length} memory object(s):\n\n${lines}\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
      }]
    };
  }
);

server.tool(
  'vmn_search',
  'Search across all memory objects in the vault by keyword query. Returns candidate roots. Use vmn_recall with a specific root to retrieve full evidence.',
  {
    query:     z.string().describe('Search query to find relevant memory objects'),
    limit:     z.number().optional().describe('Maximum number of results (default 10)'),
    namespace: z.string().optional().describe('Restrict search to this namespace only'),
  },
  async ({ query, limit, namespace }) => {
    const { results, index } = search_vault(query, limit ?? 10, namespace);
    if (index.state === 'REBUILDING') {
      return {
        content: [{
          type: 'text',
          text: `INDEX_REBUILDING — index is being rebuilt. Retry vmn_search in a moment.\n[VMN] index.state=REBUILDING | verification=LOCAL_HASH_ONLY`
        }]
      };
    }
    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No memory objects matched: "${query}"\n[VMN] index.state=${index.state} | source=local_vmn | verification=LOCAL_HASH_ONLY`
        }]
      };
    }
    const autoNote = index.index_auto_rebuilt ? ' [index auto-rebuilt]' : '';
    const lines = results.map(r =>
      `root: ${r.root}\ntitle: ${r.title}\nsnippet: ${r.snippet}\nscore: ${r.score.toFixed(3)} | segment: ${r.matched_segment} | terms: ${r.matched_terms.join(', ')}\n`
    ).join('\n---\n');
    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} matching memory object(s):${autoNote}\n\n${lines}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
      }]
    };
  }
);

server.tool(
  'vmn_inspect',
  'Inspect the catalog metadata for a specific memory shard by its SHA-256 root hash.',
  {
    hash: z.string().describe('The SHA-256 root hash of the memory object to inspect')
  },
  async ({ hash }) => {
    const entry = inspect_entry(hash);
    if (!entry) {
      return {
        content: [{
          type: 'text',
          text: `No catalog entry found for hash: ${hash}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(entry, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
      }]
    };
  }
);

server.tool(
  'vmn_delete',
  'Delete a memory object from the local vault by its SHA-256 root hash. This is permanent.',
  {
    hash: z.string().describe('The SHA-256 root hash of the memory object to delete')
  },
  async ({ hash }) => {
    const deleted = delete_entry(hash);
    return {
      content: [{
        type: 'text',
        text: deleted
          ? `Deleted memory object: ${hash}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
          : `No memory object found for hash: ${hash}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
      }]
    };
  }
);

server.tool(
  'vmn_stats',
  'Return statistics about the local Vanguard Memory Vault.',
  {},
  async () => {
    const stats = vault_stats();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(stats, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
      }]
    };
  }
);


server.tool(
  'vmn_index_status',
  'Return the current status of the BM25 inverted index. Indicates if a rebuild is needed.',
  {},
  async () => {
    const status = get_index_status();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(status, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
      }]
    };
  }
);

server.tool(
  'vmn_rebuild_index',
  'Rebuild the BM25 inverted index from existing vault objects. Safe to run at any time — objects are never modified.',
  {},
  async () => {
    const result = rebuild_index();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
      }]
    };
  }
);

server.tool(
  'vmn_sync_vault',
  'Sync a local memory object to the ExergyNet LNES-17 vault. Requires EXERGYNET_API_KEY env var.',
  {
    xlmp_root: z.string().describe('The SHA-256 root hash of the local memory object to sync'),
    intent:    z.string().optional().describe('Sync intent label (default: "manual-sync")')
  },
  async ({ xlmp_root, intent }) => {
    const payload = readVaultObject(xlmp_root);
    if (payload === null) {
      return {
        content: [{
          type: 'text',
          text: `ERROR: No local object found for root: ${xlmp_root}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
        }]
      };
    }
    const result = await syncToVault(payload, intent ?? 'manual-sync');
    if (result.status === 'unconfigured') {
      return {
        content: [{
          type: 'text',
          text: `UNCONFIGURED: ${result.message}\nSet EXERGYNET_API_KEY to enable vault sync.\n[VMN] source=local_vmn`
        }]
      };
    }
    if (result.status === 'error') {
      return {
        content: [{
          type: 'text',
          text: `SYNC_ERROR: ${result.message}\n[VMN] source=local_vmn`
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: `SYNCED. [${result.url}]\n${JSON.stringify(result.response, null, 2)}\n[VMN] source=exergynet_vault | verification=LNES17_HASH`
      }]
    };
  }
);

server.tool(
  'vmn_ingest_file',
  'Ingest new content from a file into the vault, tracking progress with a cursor so only new lines are ingested on each call. Safe to call repeatedly — only the delta since the last call is stored.',
  {
    file_path:  z.string().describe('Absolute path to the file to ingest'),
    session_id: z.string().optional().describe('Cursor key — defaults to the file path. Use a stable ID (e.g. session ID) to track the same file across calls'),
    namespace:  z.string().optional().describe('Namespace for the ingested content (default: "file_ingest")'),
    title:      z.string().optional().describe('Optional title override'),
    tags:       z.array(z.string()).optional().describe('Optional tags'),
  },
  async ({ file_path, session_id, namespace, title, tags }) => {
    const sid = session_id ?? file_path;
    try {
      const result = ingest_file_delta(file_path, sid, { namespace, title, tags });
      if (result.lines_ingested === 0) {
        return {
          content: [{
            type: 'text',
            text: `NO_NEW_CONTENT. Cursor already at line ${result.cursor_line} — file has not grown since last call.\n[VMN] source=local_vmn | session_id=${sid}`,
          }]
        };
      }
      return {
        content: [{
          type: 'text',
          text: `INGESTED. Lines ingested: ${result.lines_ingested} (cursor now at line ${result.cursor_line})\nLocal shard hash: ${result.hash}\n[VMN] source=local_vmn | session_id=${sid} | verification=LOCAL_HASH_ONLY`,
        }]
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `ERROR: ${msg}\n[VMN] source=local_vmn` }]
      };
    }
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
