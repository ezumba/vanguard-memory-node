#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ingest_text, retrieve_evidence, list_vault, search_vault, inspect_entry, delete_entry, vault_stats, get_index_status, rebuild_index } from './core.js';
const server = new McpServer({
    name: 'vanguard-memory-node',
    version: '1.3.0',
});
server.tool('vmn_ingest', 'Ingest text into the local Vanguard Memory Vault. Returns a SHA-256 shard hash.', {
    text: z.string().describe('The text content to ingest and shard locally'),
    title: z.string().optional().describe('Optional human-readable title'),
    namespace: z.string().optional().describe('Optional namespace (default: "default")'),
    tags: z.array(z.string()).optional().describe('Optional tags'),
    content_type: z.string().optional().describe('Optional content type (default: "text/plain")'),
    source: z.string().optional().describe('Optional source label')
}, async ({ text, title, namespace, tags, content_type, source }) => {
    const hash = ingest_text(text, { title, namespace, tags, content_type, source });
    return {
        content: [{
                type: 'text',
                text: `INGESTED. Local shard hash: ${hash}\nStored at: ~/.vanguard/local_vault/${hash}.txt\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
            }]
    };
});
server.tool('vmn_recall', 'Recall evidence from a local Vanguard Memory shard using deterministic xLMP lexical search.', {
    hash: z.string().describe('The SHA-256 shard hash returned by vmn_ingest'),
    query: z.string().describe('The query to search within the shard')
}, async ({ hash, query }) => {
    const evidence = retrieve_evidence(hash, query);
    return {
        content: [{
                type: 'text',
                text: `${evidence}\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY | network_verification_available=false`
            }]
    };
});
server.tool('vmn_list', 'List all memory objects in the local vault. Optionally filter by namespace.', {
    namespace: z.string().optional().describe('Optional namespace filter')
}, async ({ namespace }) => {
    const entries = list_vault(namespace);
    if (entries.length === 0) {
        return {
            content: [{
                    type: 'text',
                    text: `No entries found${namespace ? ` in namespace: ${namespace}` : ''}.\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
                }]
        };
    }
    const lines = entries.map(e => `${e.root.slice(0, 16)}... | ${e.title} | ${e.segment_count} segments | ${e.updated_at.slice(0, 10)}`).join('\n');
    return {
        content: [{
                type: 'text',
                text: `Found ${entries.length} memory object(s):\n\n${lines}\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
            }]
    };
});
server.tool('vmn_search', 'Search across all memory objects in the vault by keyword query. Returns candidate roots. Use vmn_recall with a specific root to retrieve full evidence.', {
    query: z.string().describe('Search query to find relevant memory objects'),
    limit: z.number().optional().describe('Maximum number of results (default 10)')
}, async ({ query, limit }) => {
    const { results, index } = search_vault(query, limit ?? 10);
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
    const lines = results.map(r => `root: ${r.root}\ntitle: ${r.title}\nsnippet: ${r.snippet}\nscore: ${r.score.toFixed(3)} | segment: ${r.matched_segment} | terms: ${r.matched_terms.join(', ')}\n`).join('\n---\n');
    return {
        content: [{
                type: 'text',
                text: `Found ${results.length} matching memory object(s):${autoNote}\n\n${lines}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
            }]
    };
});
server.tool('vmn_inspect', 'Inspect the catalog metadata for a specific memory shard by its SHA-256 root hash.', {
    hash: z.string().describe('The SHA-256 root hash of the memory object to inspect')
}, async ({ hash }) => {
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
});
server.tool('vmn_delete', 'Delete a memory object from the local vault by its SHA-256 root hash. This is permanent.', {
    hash: z.string().describe('The SHA-256 root hash of the memory object to delete')
}, async ({ hash }) => {
    const deleted = delete_entry(hash);
    return {
        content: [{
                type: 'text',
                text: deleted
                    ? `Deleted memory object: ${hash}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
                    : `No memory object found for hash: ${hash}\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY`
            }]
    };
});
server.tool('vmn_stats', 'Return statistics about the local Vanguard Memory Vault.', {}, async () => {
    const stats = vault_stats();
    return {
        content: [{
                type: 'text',
                text: JSON.stringify(stats, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
            }]
    };
});
server.tool('vmn_index_status', 'Return the current status of the BM25 inverted index. Indicates if a rebuild is needed.', {}, async () => {
    const status = get_index_status();
    return {
        content: [{
                type: 'text',
                text: JSON.stringify(status, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
            }]
    };
});
server.tool('vmn_rebuild_index', 'Rebuild the BM25 inverted index from existing vault objects. Safe to run at any time — objects are never modified.', {}, async () => {
    const result = rebuild_index();
    return {
        content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2) + '\n\n[VMN] source=local_vmn | verification=LOCAL_HASH_ONLY'
            }]
    };
});
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
