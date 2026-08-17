import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { NORMALIZATION_VERSION, STEMMER_VERSION, ALIAS_DICT_VERSION, normalizeQuery, computeTermFrequencies, tokenize, stemToken, } from './normalization.js';
import { INDEX_VERSION, OBJECTS_DIR, SEGMENTS_DIR, POSTINGS_DIR, CORPUS_STATS_PATH, CATALOG_DIR, CURSORS_DIR, ensureIndexDirs, termBucket, atomicWrite, loadManifest, saveManifest, indexState as getIndexState, loadBuckets, loadCorpusStats, loadSegments, loadCatalog, loadCatalogEntry, loadCatalogEntries, saveCatalogEntry, deleteCatalogEntry, } from './index_store.js';
import { recoverTransactions } from './index_transaction.js';
// Startup: recover any incomplete transactions from prior crashes
recoverTransactions();
// ── Text segmentation (preserved from v1.1.1) ─────────────────────────────────
const CHUNK_TARGET_SIZE = 1800;
const EVIDENCE_WINDOW = 900;
function splitIntoChunks(text) {
    if (!text || !text.trim())
        return [];
    const MAX = CHUNK_TARGET_SIZE;
    function packPieces(pieces, max) {
        const chunks = [];
        let cur = '';
        for (const piece of pieces) {
            if (piece.length > max) {
                if (cur) {
                    chunks.push(cur.trim());
                    cur = '';
                }
                for (let i = 0; i < piece.length; i += max)
                    chunks.push(piece.slice(i, i + max));
            }
            else {
                const joined = cur ? cur + ' ' + piece : piece;
                if (joined.length > max) {
                    if (cur)
                        chunks.push(cur.trim());
                    cur = piece;
                }
                else {
                    cur = joined;
                }
            }
        }
        if (cur.trim())
            chunks.push(cur.trim());
        return chunks;
    }
    function shatter(segment) {
        if (segment.length <= MAX)
            return [segment];
        const sentences = segment.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
            ?.map(s => s.trim()).filter(s => s.length > 0) ?? [];
        if (sentences.length > 1)
            return packPieces(sentences, MAX);
        const words = segment.split(/\s+/).filter(w => w.length > 0);
        if (words.length > 1)
            return packPieces(words, MAX);
        const out = [];
        for (let i = 0; i < segment.length; i += MAX)
            out.push(segment.slice(i, i + MAX));
        return out;
    }
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
    return paragraphs.flatMap(para => shatter(para).filter(piece => piece.trim().length > 0));
}
// ── Evidence window (for vmn_recall) ─────────────────────────────────────────
function findEvidenceWindow(chunk, queryTerms) {
    const lower = chunk.toLowerCase();
    let bestPos = -1;
    for (const term of queryTerms) {
        const prefix = term.slice(0, Math.min(term.length, 6));
        if (prefix.length < 2)
            continue;
        const pos = lower.indexOf(prefix);
        if (pos !== -1) {
            bestPos = pos;
            break;
        }
    }
    if (bestPos === -1)
        return chunk.slice(0, EVIDENCE_WINDOW).trim();
    const half = Math.floor(EVIDENCE_WINDOW / 2);
    const start = Math.max(0, bestPos - half);
    const end = Math.min(chunk.length, start + EVIDENCE_WINDOW);
    return chunk.slice(start, end).trim();
}
// ── BM25 ─────────────────────────────────────────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B = 0.75;
function bm25Score(tf, docLen, avgLen, N, df) {
    if (df === 0)
        return 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const tfn = tf * (BM25_K1 + 1) /
        (tf + BM25_K1 * (1 - BM25_B + BM25_B * docLen / Math.max(avgLen, 1)));
    return idf * tfn;
}
// MCP is single-threaded — always rebuild synchronously (no async background possible)
const SMALL_VAULT_THRESHOLD = 1000000;
// Top-K cap per term: prevents high-DF terms from stalling the search loop
const MAX_POSTINGS_PER_TERM = 150;
// ── E5: Incremental ingest ────────────────────────────────────────────────────
export function ingest_text(text, options) {
    ensureIndexDirs();
    const root = crypto.createHash('sha256').update(text).digest('hex');
    // 1. Write authoritative object (idempotent)
    const objPath = path.join(OBJECTS_DIR, `${root}.txt`);
    fs.writeFileSync(objPath, text, 'utf8');
    // 2. Segment
    const chunks = splitIntoChunks(text);
    // 3. Build segment records and map term -> bucket
    const segRecs = [];
    const newTermBuckets = new Map();
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const freq = computeTermFrequencies(chunk);
        segRecs.push({
            root,
            segment_index: i,
            start_offset: offset,
            end_offset: offset + chunk.length,
            token_count: Object.keys(freq).length,
            term_frequencies: freq,
            split_reason: 'paragraph',
            record_id: null,
            snippet: chunk.slice(0, 200),
        });
        for (const term of Object.keys(freq)) {
            newTermBuckets.set(term, termBucket(term));
        }
        offset += chunk.length;
    }
    const newBucketSet = new Set(newTermBuckets.values());
    // 4. Find old buckets to clean (re-ingest idempotency)
    const oldSegs = loadSegments(root);
    const oldBucketSet = new Set();
    for (const seg of oldSegs) {
        const terms = seg.term_frequencies ?? seg.normalized_terms ?? {};
        for (const term of Object.keys(terms)) {
            oldBucketSet.add(termBucket(term));
        }
    }
    // 5. Load all affected buckets
    const allBuckets = [...new Set([...newBucketSet, ...oldBucketSet])];
    const buckets = loadBuckets(allBuckets);
    // 6. Remove old postings for this root
    for (const [, bf] of buckets) {
        for (const term of Object.keys(bf.terms)) {
            bf.terms[term] = bf.terms[term].filter((p) => p.root !== root);
            if (bf.terms[term].length === 0)
                delete bf.terms[term];
        }
        bf.generation++;
    }
    // 7. Add new postings
    for (const seg of segRecs) {
        for (const [term, freq] of Object.entries(seg.term_frequencies)) {
            const bucket = newTermBuckets.get(term);
            const bf = buckets.get(bucket);
            if (!bf.terms[term])
                bf.terms[term] = [];
            bf.terms[term].push({ root, segment_index: seg.segment_index, frequency: freq });
        }
    }
    // 8. Write modified bucket files (only affected buckets touched)
    for (const [bucket, bf] of buckets) {
        atomicWrite(path.join(POSTINGS_DIR, `${bucket}.json`), bf);
    }
    // 9. Write segment file
    atomicWrite(path.join(SEGMENTS_DIR, `${root}.json`), segRecs);
    // 10. Update catalog
    const now = new Date().toISOString();
    const existing = loadCatalogEntry(root);
    saveCatalogEntry({
        root,
        title: options?.title ?? text.slice(0, 60).replace(/\n/g, ' ').trim(),
        namespace: options?.namespace ?? 'default',
        tags: options?.tags ?? [],
        content_type: options?.content_type ?? 'text/plain',
        size_bytes: Buffer.byteLength(text, 'utf8'),
        segment_count: chunks.length,
        ingested_at: existing?.ingested_at ?? now,
        updated_at: now,
        excerpt: text.slice(0, 120).replace(/\n/g, ' ').trim(),
    });
    // 11. Update corpus stats
    const stats = loadCorpusStats();
    const totalTokens = segRecs.reduce((s, r) => s + r.token_count, 0);
    stats.per_root[root] = { total_tokens: totalTokens, segment_count: chunks.length };
    stats.total_roots = Object.keys(stats.per_root).length;
    stats.total_tokens = Object.values(stats.per_root).reduce((s, r) => s + r.total_tokens, 0);
    stats.avg_doc_length = stats.total_tokens / Math.max(stats.total_roots, 1);
    atomicWrite(CORPUS_STATS_PATH, stats);
    // 12. Update manifest
    const manifest = loadManifest() ?? {
        index_version: INDEX_VERSION,
        normalization_version: NORMALIZATION_VERSION,
        stemmer_version: STEMMER_VERSION,
        alias_dictionary_version: ALIAS_DICT_VERSION,
        root_count: 0,
        segment_count: 0,
        generation: 0,
        state: 'READY',
        last_rebuilt_at: null,
        last_transaction_id: null,
    };
    manifest.root_count = stats.total_roots;
    manifest.segment_count = Object.values(stats.per_root).reduce((s, r) => s + r.segment_count, 0);
    manifest.state = 'READY';
    saveManifest(manifest);
    return root;
}
// ── E6: Sharded BM25 search ───────────────────────────────────────────────────
export function search_vault(query, limit = 10, namespace) {
    ensureIndexDirs();
    const state = getIndexState();
    let autoRebuilt = false;
    // E8: Migration / rebuild detection
    if (state !== 'READY') {
        const catalog = loadCatalog();
        const rootCount = Object.keys(catalog).length;
        if (rootCount === 0) {
            return { results: [], index: { version: INDEX_VERSION, state: 'READY', index_auto_rebuilt: false } };
        }
        if (rootCount <= SMALL_VAULT_THRESHOLD) {
            // Small vault: synchronous auto-rebuild then continue to search
            rebuild_index();
            autoRebuilt = true;
        }
        else {
            // Large vault: never return silent [] — explicit REBUILDING
            return {
                results: [],
                index: { version: INDEX_VERSION, state: 'REBUILDING', index_auto_rebuilt: false },
            };
        }
    }
    const queryTerms = normalizeQuery(query);
    if (queryTerms.length === 0) {
        return { results: [], index: { version: INDEX_VERSION, state: 'READY', index_auto_rebuilt: autoRebuilt } };
    }
    // Load only the buckets required by normalized query terms
    const bucketSet = new Set(queryTerms.map(termBucket));
    const buckets = loadBuckets([...bucketSet]);
    const stats = loadCorpusStats();
    const totalDocs = stats.total_roots;
    if (totalDocs === 0) {
        return { results: [], index: { version: INDEX_VERSION, state: 'READY', index_auto_rebuilt: autoRebuilt } };
    }
    const avgDocLength = stats.avg_doc_length;
    // Accumulate segment-level BM25 scores
    const segmentScores = new Map();
    for (const term of queryTerms) {
        const bf = buckets.get(termBucket(term));
        if (!bf)
            continue;
        const allHits = bf.terms[term] || [];
        // Use true DF for IDF accuracy, but cap scoring to top-K by frequency
        const docsWithTerm = new Set(allHits.map(h => h.root)).size;
        const hits = allHits.length > MAX_POSTINGS_PER_TERM
            ? [...allHits].sort((a, b) => b.frequency - a.frequency).slice(0, MAX_POSTINGS_PER_TERM)
            : allHits;
        for (const hit of hits) {
            const rootStats = stats.per_root[hit.root];
            if (!rootStats)
                continue;
            const score = bm25Score(hit.frequency, rootStats.total_tokens, avgDocLength, totalDocs, docsWithTerm);
            const key = `${hit.root}:${hit.segment_index}`;
            const existing = segmentScores.get(key);
            if (existing) {
                existing.score += score;
                if (!existing.terms.includes(term))
                    existing.terms.push(term);
            }
            else {
                segmentScores.set(key, { root: hit.root, segIdx: hit.segment_index, score, terms: [term] });
            }
        }
    }
    if (segmentScores.size === 0) {
        return { results: [], index: { version: INDEX_VERSION, state: 'READY', index_auto_rebuilt: autoRebuilt } };
    }
    // Best segment per root (score desc -> segIdx asc tie-break)
    const rootBest = new Map();
    for (const [, seg] of segmentScores) {
        const existing = rootBest.get(seg.root);
        if (!existing ||
            seg.score > existing.score ||
            (seg.score === existing.score && seg.segIdx < existing.segIdx)) {
            rootBest.set(seg.root, { score: seg.score, segIdx: seg.segIdx, terms: seg.terms });
        }
    }
    // Load catalog only for matched roots (avoids O(N) scan)
    const allCatalog = loadCatalogEntries([...rootBest.keys()]);
    const results = [];
    for (const [root, best] of rootBest) {
        const entry = allCatalog[root];
        if (namespace && entry?.namespace !== namespace)
            continue;
        let snippet = entry?.excerpt || '';
        let startOff = 0;
        let endOff = snippet.length;
        const segs = loadSegments(root);
        const seg = segs[best.segIdx];
        if (seg) {
            snippet = seg.snippet || seg.text_snippet || '';
            startOff = seg.start_offset;
            endOff = seg.end_offset;
            // Keyword-centered snippet from raw object text
            const objPath = path.join(OBJECTS_DIR, `${root}.txt`);
            if (fs.existsSync(objPath)) {
                try {
                    const fullText = fs.readFileSync(objPath, 'utf8');
                    const segText = fullText.slice(seg.start_offset, seg.end_offset);
                    const lower = segText.toLowerCase();
                    const queryToks = query.toLowerCase()
                        .replace(/[^\w\s]/g, ' ')
                        .split(/\s+/)
                        .filter((t) => t.length >= 3);
                    let bestPos = -1;
                    for (const tok of queryToks) {
                        const pos = lower.indexOf(tok.slice(0, Math.min(tok.length, 10)));
                        if (pos !== -1) {
                            bestPos = pos;
                            break;
                        }
                    }
                    if (bestPos !== -1) {
                        const sStart = Math.max(0, bestPos - 60);
                        const sEnd = Math.min(segText.length, sStart + 200);
                        snippet = segText.slice(sStart, sEnd);
                    }
                }
                catch { /* keep stored snippet */ }
            }
        }
        results.push({
            root,
            title: entry?.title || root,
            score: Math.round(best.score * 1000) / 1000,
            matched_terms: [...new Set(best.terms)],
            matched_segment: best.segIdx,
            snippet,
            start_offset: startOff,
            end_offset: endOff,
            source: 'local_vmn',
            verification: 'LOCAL_HASH_ONLY',
        });
    }
    // Deterministic: score desc -> root asc -> segment asc
    results.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (a.root !== b.root)
            return a.root < b.root ? -1 : 1;
        return a.matched_segment - b.matched_segment;
    });
    return {
        results: results.slice(0, limit),
        index: { version: INDEX_VERSION, state: 'READY', index_auto_rebuilt: autoRebuilt },
    };
}
// ── E7: Root-bound recall (unified normalization) ─────────────────────────────
export function retrieve_evidence(hash, query) {
    ensureIndexDirs();
    const filePath = path.join(OBJECTS_DIR, `${hash}.txt`);
    if (!fs.existsSync(filePath)) {
        return `ERROR: Shard ${hash} not found in local vault.`;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const chunks = splitIntoChunks(text);
    const queryTerms = normalizeQuery(query);
    if (queryTerms.length === 0)
        return 'no_relevant_evidence_found';
    // Score chunks by normalized term overlap — same pipeline as search_vault
    let bestScore = -1;
    let bestChunk = '';
    for (const chunk of chunks) {
        const chunkFreqs = computeTermFrequencies(chunk);
        let score = 0;
        // Primary: exact normalized term match (weighted by frequency)
        for (const qt of queryTerms) {
            if (chunkFreqs[qt])
                score += chunkFreqs[qt] * 2;
        }
        // Fallback: stemmed-token match (only when primary=0)
        // Stems each chunk word and compares stems — medications→medicat matches
        // medication→medicat, but generic→gener never matches generator→generator
        if (score === 0) {
            const chunkStems = new Set(tokenize(chunk).map(w => stemToken(w)));
            if (queryTerms.some(qt => chunkStems.has(qt)))
                score += 0.5;
        }
        if (score > bestScore) {
            bestScore = score;
            bestChunk = chunk;
        }
    }
    // Zero-score rejection invariant: never return a chunk when nothing matched
    if (bestScore <= 0)
        return 'no_relevant_evidence_found';
    return findEvidenceWindow(bestChunk, queryTerms);
}
// ── List, inspect ─────────────────────────────────────────────────────────────
export function list_vault(namespace) {
    ensureIndexDirs();
    const catalog = loadCatalog();
    const entries = Object.values(catalog);
    return namespace ? entries.filter(e => e.namespace === namespace) : entries;
}
export function inspect_entry(hash) {
    ensureIndexDirs();
    const catalog = loadCatalog();
    return catalog[hash] ?? null;
}
// ── E9: Delete (sharded bucket cleanup) ───────────────────────────────────────
export function delete_entry(hash) {
    ensureIndexDirs();
    let deleted = false;
    // Determine which buckets to clean from existing segment records
    const segs = loadSegments(hash);
    const bucketsToClean = new Set();
    for (const seg of segs) {
        const terms = seg.term_frequencies ?? seg.normalized_terms ?? {};
        for (const term of Object.keys(terms)) {
            bucketsToClean.add(termBucket(term));
        }
    }
    // Delete authoritative object
    const objPath = path.join(OBJECTS_DIR, `${hash}.txt`);
    if (fs.existsSync(objPath)) {
        fs.unlinkSync(objPath);
        deleted = true;
    }
    // Delete segment file
    const segPath = path.join(SEGMENTS_DIR, `${hash}.json`);
    if (fs.existsSync(segPath))
        fs.unlinkSync(segPath);
    // Remove from catalog
    const catPath = path.join(CATALOG_DIR, `${hash}.json`);
    if (fs.existsSync(catPath)) {
        deleteCatalogEntry(hash);
        deleted = true;
    }
    // Remove postings from affected buckets only
    if (bucketsToClean.size > 0) {
        const buckets = loadBuckets([...bucketsToClean]);
        for (const [bucket, bf] of buckets) {
            let changed = false;
            for (const term of Object.keys(bf.terms)) {
                const before = bf.terms[term].length;
                bf.terms[term] = bf.terms[term].filter((p) => p.root !== hash);
                if (bf.terms[term].length === 0) {
                    delete bf.terms[term];
                    changed = true;
                }
                else if (bf.terms[term].length !== before)
                    changed = true;
            }
            if (changed) {
                bf.generation++;
                atomicWrite(path.join(POSTINGS_DIR, `${bucket}.json`), bf);
            }
        }
    }
    // Update corpus stats
    const stats = loadCorpusStats();
    if (stats.per_root[hash]) {
        delete stats.per_root[hash];
        stats.total_roots = Object.keys(stats.per_root).length;
        stats.total_tokens = Object.values(stats.per_root).reduce((s, r) => s + r.total_tokens, 0);
        stats.avg_doc_length = stats.total_tokens / Math.max(stats.total_roots, 1);
        atomicWrite(CORPUS_STATS_PATH, stats);
    }
    // Update manifest root count
    const manifest = loadManifest();
    if (manifest) {
        manifest.root_count = stats.total_roots;
        manifest.segment_count = Object.values(stats.per_root).reduce((s, r) => s + r.segment_count, 0);
        saveManifest(manifest);
    }
    return deleted;
}
// ── Stats ─────────────────────────────────────────────────────────────────────
export function vault_stats() {
    ensureIndexDirs();
    const catalog = loadCatalog();
    const entries = Object.values(catalog);
    if (entries.length === 0) {
        return { total_entries: 0, total_bytes: 0, namespaces: [], oldest_at: null, newest_at: null };
    }
    const namespaces = [...new Set(entries.map(e => e.namespace))];
    const sortedByDate = entries.map(e => e.ingested_at).sort();
    return {
        total_entries: entries.length,
        total_bytes: entries.reduce((s, e) => s + (e.size_bytes ?? e.byte_size ?? 0), 0),
        namespaces,
        oldest_at: sortedByDate[0],
        newest_at: sortedByDate[sortedByDate.length - 1],
    };
}
// ── Index status ──────────────────────────────────────────────────────────────
export function get_index_status() {
    const manifest = loadManifest();
    const catalog = loadCatalog();
    const stats = loadCorpusStats();
    const state = getIndexState();
    return {
        status: state === 'READY' ? 'OK' : 'INDEX_REBUILD_REQUIRED',
        index_version: manifest?.index_version ?? null,
        state,
        indexed_root_count: stats.total_roots,
        catalog_root_count: Object.keys(catalog).length,
        needs_rebuild: state !== 'READY',
        built_at: manifest?.last_rebuilt_at ?? null,
        objects_preserved: true,
    };
}
// ── E9: Full index rebuild (sharded) ─────────────────────────────────────────
export function rebuild_index() {
    ensureIndexDirs();
    const catalog = loadCatalog();
    const errors = [];
    let indexed = 0;
    const newBuckets = new Map();
    const newPerRoot = {};
    for (const [root, catEntry] of Object.entries(catalog)) {
        const objPath = path.join(OBJECTS_DIR, `${root}.txt`);
        if (!fs.existsSync(objPath)) {
            errors.push(`Missing object: ${root}`);
            continue;
        }
        try {
            const text = fs.readFileSync(objPath, 'utf8');
            const chunks = splitIntoChunks(text);
            const segRecs = [];
            let offset = 0;
            let totalTokens = 0;
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const freq = computeTermFrequencies(chunk);
                totalTokens += Object.keys(freq).length;
                segRecs.push({
                    root,
                    segment_index: i,
                    start_offset: offset,
                    end_offset: offset + chunk.length,
                    token_count: Object.keys(freq).length,
                    term_frequencies: freq,
                    split_reason: 'paragraph',
                    record_id: null,
                    snippet: chunk.slice(0, 200),
                });
                for (const [term, freq2] of Object.entries(freq)) {
                    const bucket = termBucket(term);
                    if (!newBuckets.has(bucket)) {
                        newBuckets.set(bucket, { schema_version: 2, bucket, generation: 0, terms: {} });
                    }
                    const bf = newBuckets.get(bucket);
                    if (!bf.terms[term])
                        bf.terms[term] = [];
                    bf.terms[term].push({ root, segment_index: i, frequency: freq2 });
                }
                offset += chunk.length;
            }
            atomicWrite(path.join(SEGMENTS_DIR, `${root}.json`), segRecs);
            // Migrate catalog to v2 field names (byte_size -> size_bytes)
            const now = new Date().toISOString();
            saveCatalogEntry({
                root,
                title: catEntry?.title ?? root.slice(0, 16),
                namespace: catEntry?.namespace ?? 'default',
                tags: catEntry?.tags ?? [],
                content_type: catEntry?.content_type ?? 'text/plain',
                size_bytes: catEntry?.size_bytes ?? catEntry?.byte_size ?? Buffer.byteLength(text, 'utf8'),
                segment_count: chunks.length,
                ingested_at: catEntry?.ingested_at ?? now,
                updated_at: now,
                excerpt: catEntry?.excerpt ?? text.slice(0, 120).replace(/\n/g, ' ').trim(),
            });
            newPerRoot[root] = { total_tokens: totalTokens, segment_count: chunks.length };
            indexed++;
        }
        catch (e) {
            errors.push(`Failed to index ${root}: ${e.message}`);
        }
    }
    // Write all touched bucket files
    for (const [, bf] of newBuckets) {
        bf.generation++;
        atomicWrite(path.join(POSTINGS_DIR, `${bf.bucket}.json`), bf);
    }
    // Write corpus stats
    const totalTok = Object.values(newPerRoot).reduce((s, r) => s + r.total_tokens, 0);
    const totalRoot = Object.keys(newPerRoot).length;
    const corpusStats = {
        total_roots: totalRoot,
        total_tokens: totalTok,
        avg_doc_length: totalTok / Math.max(totalRoot, 1),
        per_root: newPerRoot,
    };
    atomicWrite(CORPUS_STATS_PATH, corpusStats);
    // Write v2 manifest
    saveManifest({
        index_version: INDEX_VERSION,
        normalization_version: NORMALIZATION_VERSION,
        stemmer_version: STEMMER_VERSION,
        alias_dictionary_version: ALIAS_DICT_VERSION,
        root_count: indexed,
        segment_count: Object.values(newPerRoot).reduce((s, r) => s + r.segment_count, 0),
        generation: (loadManifest()?.generation ?? 0) + 1,
        state: 'READY',
        last_rebuilt_at: new Date().toISOString(),
        last_transaction_id: null,
    });
    return { success: errors.length === 0, roots_indexed: indexed, errors };
}
export function ingest_file_delta(filePath, sessionId, options) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }
    // Load cursor
    fs.mkdirSync(CURSORS_DIR, { recursive: true });
    const cursorPath = path.join(CURSORS_DIR, `${sessionId}.json`);
    let lastLine = 0;
    if (fs.existsSync(cursorPath)) {
        try {
            lastLine = JSON.parse(fs.readFileSync(cursorPath, 'utf8')).last_line ?? 0;
        }
        catch { }
    }
    // Read only new lines
    const raw = fs.readFileSync(filePath, 'utf8').split('\n');
    const lines = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
    const newLines = lines.slice(lastLine);
    if (newLines.length === 0) {
        return { hash: null, lines_ingested: 0, cursor_line: lastLine };
    }
    // Ingest delta
    const hash = ingest_text(newLines.join('\n'), {
        title: options?.title ?? path.basename(filePath),
        namespace: options?.namespace ?? 'file_ingest',
        tags: options?.tags ?? ['auto-ingest', 'file-delta'],
        source: filePath,
    });
    // Advance cursor
    const newCursorLine = lastLine + newLines.length;
    atomicWrite(cursorPath, {
        file_path: filePath,
        last_line: newCursorLine,
        updated_at: new Date().toISOString(),
    });
    return { hash, lines_ingested: newLines.length, cursor_line: newCursorLine };
}
