#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ingest_text,
  retrieve_evidence_adaptive,
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
import { BENCHMARK_RECORDS, compute_context_comparison } from './benchmarks.js';

const server = new McpServer({
  name: 'vanguard-memory-node',
  version: '2.1.0',
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
    const evidence = retrieve_evidence_adaptive(hash, query);
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

server.tool(
  'vmn_benchmark_evidence',
  'Return evidence-native benchmark records for ExergyNet xLMP experiments. Every record carries ' +
  'benchmark_id, measured_value, unit, tested_envelope, derivation_type (MEASURED | DERIVED | REFERENCE_ONLY), ' +
  'evidence_class, evidence_sha256, publicly_verifiable, and universal_claim=false. ' +
  'publicly_verifiable=true would mean a public consumer can independently obtain and verify the referenced ' +
  'evidence artifact from the record alone, without internal access; it is false here because no public ' +
  'artifact URL exists yet (the evidence documents are internal/sealed), so verification currently requires ' +
  'possession of the named artifact and recomputation of its SHA-256. ' +
  'Use vmn_context_cost_compare to derive economic implications from this data.',
  {
    benchmark_id: z.string().optional().describe(
      'Filter to a specific benchmark_id. Omit to return all records. ' +
      'Known IDs: LNES82C10M-HOLDOUT-MEAN-K, LNES82C10M-STATE-RATIO, LNES82C10M-ACCURACY, ' +
      'LNES82C4M-OLS-9PT-SLOPE, H200-XLMP-CORRECT-TASK-THROUGHPUT'
    ),
    include_derivations: z.boolean().optional().describe(
      'If true, include derivation_notes fields. Default: false.'
    ),
  },
  async ({ benchmark_id, include_derivations }) => {
    const filtered = benchmark_id
      ? BENCHMARK_RECORDS.filter(r => r.benchmark_id === benchmark_id)
      : BENCHMARK_RECORDS;
    if (filtered.length === 0) {
      const ids = BENCHMARK_RECORDS.map(r => r.benchmark_id).join(', ');
      return {
        content: [{
          type: 'text',
          text: `No benchmark record found for benchmark_id: "${benchmark_id}"\nAvailable IDs: ${ids}\n[VMN] source=evidence_store | verification=LOCAL_HASH_ONLY`,
        }]
      };
    }
    const records = include_derivations
      ? filtered
      : filtered.map(({ derivation_notes: _dn, ...rest }) => rest);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(records, null, 2) + '\n\n[VMN] source=evidence_store | verification=LOCAL_HASH_ONLY',
      }]
    };
  }
);

server.tool(
  'vmn_context_cost_compare',
  'Compute context cost comparison using evidence-grade measured xLMP K data. ' +
  'The agent derives the economic implication; this tool performs the arithmetic from measured inputs. ' +
  'All claims carry tested_envelope, claim_boundary, and universal_claim=false.',
  {
    corpus_tokens: z.number().describe(
      'Size of the persistent corpus in tokens (est. tokens, not characters)'
    ),
    queries_per_day: z.number().optional().describe(
      'Queries per day for throughput calculations (default: 1)'
    ),
    assumed_full_context_tokens: z.number().optional().describe(
      'Tokens per query if full context were sent. Defaults to min(corpus_tokens, 128000). ' +
      'Override to model a different context window size.'
    ),
    cost_per_million_input_tokens: z.number().optional().describe(
      'USD per million input tokens. If provided, computes cost savings per query and per day.'
    ),
  },
  async ({ corpus_tokens, queries_per_day, assumed_full_context_tokens, cost_per_million_input_tokens }) => {
    try {
      const result = compute_context_comparison(
        corpus_tokens,
        queries_per_day,
        assumed_full_context_tokens,
        cost_per_million_input_tokens,
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2) + '\n\n[VMN] source=evidence_store | verification=LOCAL_HASH_ONLY',
        }]
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text',
          text: `ERROR: invalid input — ${msg}\n[VMN] source=evidence_store | verification=LOCAL_HASH_ONLY`,
        }]
      };
    }
  }
);

// ── MCP Resources ─────────────────────────────────────────────────────────────

const SCALING_BENCHMARK_IDS = [
  'LNES82C10M-HOLDOUT-MEAN-K',
  'LNES82C10M-STATE-RATIO',
  'LNES82C4M-OLS-9PT-SLOPE',
];

server.registerResource(
  'xlmp-memory-scaling',
  'exergynet://benchmarks/xlmp-memory-scaling',
  {
    description: 'xLMP N→K memory scaling benchmark records (LNES-82C campaign). ' +
      'Evidence-native JSON: mean_K, state-to-active-context ratio, 9-pt OLS slope. ' +
      'All records carry universal_claim=false and tested_envelope.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(
        BENCHMARK_RECORDS.filter(r => SCALING_BENCHMARK_IDS.includes(r.benchmark_id)),
        null,
        2
      ),
    }]
  })
);

server.registerResource(
  'h200-throughput',
  'exergynet://benchmarks/h200-throughput',
  {
    description: 'H200 throughput record (derivation_type=REFERENCE_ONLY). ' +
      '~11.3× correct-task throughput vs full-context at a tested SLA-compliant operating point on H200. ' +
      'Restated from an internal engineering report (evidence_sha256 pinned); publicly_verifiable=false. ' +
      'Carries tested_envelope, claim_boundary, and universal_claim=false.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(
        BENCHMARK_RECORDS.filter(r => r.benchmark_id === 'H200-XLMP-CORRECT-TASK-THROUGHPUT'),
        null,
        2
      ),
    }]
  })
);

server.registerResource(
  'claim-boundaries',
  'exergynet://benchmarks/claim-boundaries',
  {
    description: 'Claim boundary documentation for all ExergyNet xLMP benchmark records. ' +
      'Use this resource to understand what each quantitative claim does and does not assert.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [{
      uri: uri.toString(),
      mimeType: 'application/json',
      text: JSON.stringify(
        BENCHMARK_RECORDS.map(r => ({
          benchmark_id: r.benchmark_id,
          measured_value: r.measured_value,
          unit: r.unit,
          universal_claim: r.universal_claim,
          claim_boundary: r.claim_boundary,
          tested_envelope: r.tested_envelope,
        })),
        null,
        2
      ),
    }]
  })
);

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
