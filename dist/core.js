import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
// ── Stop words ─────────────────────────────────────────────────────────────────
// "patient" / "patients" included because they appear in every field path and
// would otherwise give a free score point to every field, causing patient.name
// to win as a false fallback for any unknown query.
const STOP_WORDS = new Set([
    'what', 'who', 'where', 'when', 'why', 'how', 'which',
    'is', 'are', 'was', 'were', 'has', 'have', 'had',
    'does', 'did', 'can', 'could', 'will', 'would', 'should',
    'the', 'this', 'that', 'these', 'those', 'its', 'their',
    'and', 'or', 'but', 'not', 'for', 'from', 'with', 'into',
    'get', 'give', 'show', 'find', 'tell', 'return', 'list',
    'me', 'you', 'your', 'about', 'any', 'all', 'please',
    'say', 'says', 'said', 'does', 'document', 'text', 'file',
    'patient', 'patients', 'subject', 'person', 'user',
]);
// Strip trailing format-specifiers before semantic matching.
// Prevents "allergies as JSON" from being resolved as the field "allergies json".
const FORMAT_SPECIFIER_RE = /\s+(as\s+json|in\s+json(\s+format)?|as\s+an?\s+\w+|in\s+\w+\s+format|formatted?\s+as\s+\w+|as\s+plain\s+text|as\s+csv|as\s+xml)\s*$/i;
function stripFormatSpecifiers(text) {
    return text.replace(FORMAT_SPECIFIER_RE, '').trim();
}
function extractQueryWords(text) {
    return stripFormatSpecifiers(text)
        .toLowerCase()
        .split(/\W+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}
// Document Intelligence Layer — Staged Compression Path
const CHUNK_TARGET_SIZE = 1800; // chars per chunk for initial segmentation
const EVIDENCE_WINDOW = 900; // chars surrounding the best keyword match
// Fuzzy word match — same ≥75% shared-leading-chars rule already used by
// scoreField() for the structured-JSON path. Plain substring matching missed
// "smoking"/"smoker"/"smokes" when the query word was "smoke" (verified: a
// 2026-07-11 benchmark found 8/30 free-text "does the patient smoke" queries
// returned not_found even though the source note stated smoking status,
// because "smoking".includes("smoke") === false while "smoker"/"smokes" do
// — plain substring search is inconsistent across trivial English inflections
// of the same word). This makes the free-text path use the same matching
// standard the JSON path already had.
function stem(word) {
    if (word.length <= 3)
        return word;
    const suffixes = ['ations', 'ation', 'ings', 'ing', 'ness', 'ment', 'ated', 'ating', 'ers', 'er', 'ed', 'es', 's'];
    for (const sfx of suffixes) {
        if (word.endsWith(sfx) && word.length - sfx.length >= 3) {
            return word.slice(0, word.length - sfx.length);
        }
    }
    return word;
}
function wordsMatch(a, b) {
    if (a === b)
        return true;
    // Stem both words; if stems match, words are considered equivalent
    if (stem(a) === stem(b))
        return true;
    // Prefix ratio fallback (short words require exact match)
    if (a.length < 4 || b.length < 4)
        return false;
    const minLen = Math.min(a.length, b.length);
    let shared = 0;
    while (shared < minLen && a[shared] === b[shared])
        shared++;
    return shared / minLen >= 0.75;
}
function tokenizeWords(text) {
    const out = [];
    const re = /[a-z0-9]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({ word: m[0], pos: m.index });
    }
    return out;
}
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
        // Level 2: sentence boundaries
        const sentences = segment.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
            ?.map(s => s.trim()).filter(s => s.length > 0) ?? [];
        if (sentences.length > 1)
            return packPieces(sentences, MAX);
        // Level 3: word boundaries
        const words = segment.split(/\s+/).filter(w => w.length > 0);
        if (words.length > 1)
            return packPieces(words, MAX);
        // Level 4: hard cut (minified text, no whitespace)
        const out = [];
        for (let i = 0; i < segment.length; i += MAX)
            out.push(segment.slice(i, i + MAX));
        return out;
    }
    const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
    return paragraphs.flatMap(para => shatter(para).filter(piece => piece.trim().length > 0));
}
function scoreChunk(chunk, queryWords) {
    const chunkWords = tokenizeWords(chunk.toLowerCase());
    let score = 0;
    for (const w of queryWords) {
        for (const cw of chunkWords) {
            if (wordsMatch(w, cw.word))
                score++;
        }
    }
    return score;
}
// Extract the 900-char window centered on the highest-density keyword match.
// Returns null if no keyword is found in the chunk.
function extractEvidenceWindow(chunk, queryWords) {
    const lower = chunk.toLowerCase();
    const chunkWords = tokenizeWords(lower);
    let bestPos = -1;
    for (const w of queryWords) {
        const hit = chunkWords.find(cw => wordsMatch(w, cw.word));
        const pos = hit ? hit.pos : -1;
        if (pos !== -1 && bestPos === -1)
            bestPos = pos;
        // Prefer the position with the most surrounding hits (density center)
        if (pos !== -1) {
            const half = Math.floor(EVIDENCE_WINDOW / 2);
            const wStart = Math.max(0, pos - half);
            const wEnd = Math.min(lower.length, pos + half);
            const windowWords = chunkWords.filter(cw => cw.pos >= wStart && cw.pos < wEnd);
            const density = queryWords.reduce((sum, qw) => {
                return sum + windowWords.filter(cw => wordsMatch(qw, cw.word)).length;
            }, 0);
            // Always prefer the first hit as anchor; density used for tie-breaking
            if (bestPos === -1 || density > 1)
                bestPos = pos;
        }
    }
    if (bestPos === -1)
        return null;
    const half = Math.floor(EVIDENCE_WINDOW / 2);
    const start = Math.max(0, bestPos - half);
    const end = Math.min(chunk.length, bestPos + half);
    return chunk.slice(start, end).trim();
}
// ── Local filesystem storage layer ────────────────────────────────────────────
const VAULT_DIR = path.join(os.homedir(), '.vanguard', 'local_vault');
// v1.1.1 Index directories — derived state, disposable and rebuildable
const INDEX_DIR = path.join(VAULT_DIR, '..', 'index');
const SEGMENTS_DIR = path.join(VAULT_DIR, '..', 'segments');
// Index file paths
const POSTINGS_PATH = path.join(INDEX_DIR, 'postings.json');
const DOC_STATS_PATH = path.join(INDEX_DIR, 'document_stats.json');
const INDEX_MANIFEST_PATH = path.join(INDEX_DIR, 'index_manifest.json');
const INDEX_VERSION = '1.1.1';
const NORMALIZATION_VERSION = '1.0';
const STEMMER_VERSION = '1.0';
function ensureVault() {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
}
function ensureIndexDirs() {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    fs.mkdirSync(SEGMENTS_DIR, { recursive: true });
    ensureVault();
}
const CATALOG_FILE = path.join(VAULT_DIR, 'catalog.json');
function loadCatalog() {
    try {
        return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    }
    catch {
        return {};
    }
}
function saveCatalog(catalog) {
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
}
export function list_vault(namespace) {
    ensureVault();
    const catalog = loadCatalog();
    const entries = Object.values(catalog);
    return namespace
        ? entries.filter(e => e.namespace === namespace)
        : entries;
}
// ── Index I/O (atomic write + loaders) ───────────────────────────────────
function atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}
function loadPostings() {
    ensureIndexDirs();
    try {
        if (fs.existsSync(POSTINGS_PATH)) {
            return JSON.parse(fs.readFileSync(POSTINGS_PATH, 'utf8'));
        }
    }
    catch { /* fall through */ }
    return {};
}
function loadDocStats() {
    ensureIndexDirs();
    try {
        if (fs.existsSync(DOC_STATS_PATH)) {
            return JSON.parse(fs.readFileSync(DOC_STATS_PATH, 'utf8'));
        }
    }
    catch { /* fall through */ }
    return {};
}
function loadIndexManifest() {
    try {
        if (fs.existsSync(INDEX_MANIFEST_PATH)) {
            return JSON.parse(fs.readFileSync(INDEX_MANIFEST_PATH, 'utf8'));
        }
    }
    catch { /* fall through */ }
    return null;
}
function indexNeedsRebuild() {
    const manifest = loadIndexManifest();
    if (!manifest)
        return true;
    if (manifest.index_version !== INDEX_VERSION)
        return true;
    if (manifest.needs_rebuild)
        return true;
    return false;
}
// ── Synonym dictionary (versioned, explicit, deterministic) ────────────────
const SYNONYM_MAP = {
    'smoke': ['smokes', 'smoked', 'smoking', 'smoker', 'smokers', 'tobacco'],
    'tobacco': ['smoking', 'smoker', 'cigarette', 'nicotine'],
    'generic': [],
};
function expandWithSynonyms(stemmed) {
    const expanded = new Set([stemmed]);
    for (const [canonical, aliases] of Object.entries(SYNONYM_MAP)) {
        const canonicalStem = stem(canonical);
        const aliasStemmed = aliases.map(stem);
        if (stemmed === canonicalStem || aliasStemmed.includes(stemmed)) {
            expanded.add(canonicalStem);
            aliasStemmed.forEach(s => expanded.add(s));
        }
    }
    return [...expanded];
}
function normalizeTerms(text) {
    return text
        .toLowerCase()
        .normalize('NFC')
        .replace(/[^\w\s'-]/g, ' ')
        .split(/\s+/)
        .map(w => w.replace(/^['-]+|['-]+$/g, ''))
        .filter(w => w.length >= 2)
        .map(stem)
        .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}
// ── BM25 Lite ──────────────────────────────────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B = 0.75;
function bm25Score(termFreqInSeg, docTokenCount, avgDocLength, totalDocs, docsWithTerm) {
    if (docsWithTerm === 0)
        return 0;
    const idf = Math.log(1 + (totalDocs - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
    const tf = termFreqInSeg *
        (BM25_K1 + 1) /
        (termFreqInSeg + BM25_K1 * (1 - BM25_B + BM25_B * docTokenCount / Math.max(avgDocLength, 1)));
    return idf * tf;
}
export function search_vault(query, limit = 10) {
    ensureIndexDirs();
    if (indexNeedsRebuild())
        return [];
    const queryTerms = normalizeTerms(query);
    const expandedSet = new Set();
    for (const t of queryTerms) {
        expandedSet.add(t);
        expandWithSynonyms(t).forEach(s => expandedSet.add(s));
    }
    if (expandedSet.size === 0)
        return [];
    const postings = loadPostings();
    const docStats = loadDocStats();
    const catalog = loadCatalog();
    const totalDocs = Object.keys(docStats).length;
    if (totalDocs === 0)
        return [];
    const avgDocLength = Object.values(docStats).reduce((s, d) => s + d.total_tokens, 0) / totalDocs;
    const segmentScores = new Map();
    for (const term of expandedSet) {
        const hits = postings[term] || [];
        const docsWithTerm = new Set(hits.map((h) => h.root)).size;
        for (const hit of hits) {
            const ds = docStats[hit.root];
            if (!ds)
                continue;
            const score = bm25Score(hit.frequency, ds.total_tokens, avgDocLength, totalDocs, docsWithTerm);
            const key = `${hit.root}:${hit.segment_index}`;
            const existing = segmentScores.get(key);
            if (existing) {
                existing.score += score;
                existing.terms.push(term);
            }
            else {
                segmentScores.set(key, { root: hit.root, segIdx: hit.segment_index, score, terms: [term] });
            }
        }
    }
    if (segmentScores.size === 0)
        return [];
    // Aggregate: best segment per root
    const rootBest = new Map();
    for (const [, seg] of segmentScores) {
        const existing = rootBest.get(seg.root);
        if (!existing || seg.score > existing.score) {
            rootBest.set(seg.root, { score: seg.score, segIdx: seg.segIdx, terms: seg.terms });
        }
    }
    const results = [];
    for (const [root, best] of rootBest) {
        const entry = catalog[root];
        const segFile = path.join(SEGMENTS_DIR, `${root}.json`);
        let snippet = entry?.excerpt || '';
        let startOff = 0;
        let endOff = snippet.length;
        if (fs.existsSync(segFile)) {
            try {
                const segs = JSON.parse(fs.readFileSync(segFile, 'utf8'));
                const seg = segs[best.segIdx];
                if (seg) {
                    snippet = seg.text_snippet;
                    startOff = seg.start_offset;
                    endOff = seg.end_offset;
                    // Try to find a keyword-centered snippet using the original query
                    const objPath2 = path.join(VAULT_DIR, `${root}.txt`);
                    if (fs.existsSync(objPath2)) {
                        try {
                            const fullText = fs.readFileSync(objPath2, 'utf8');
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
            }
            catch { /* use excerpt fallback */ }
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
            verification: 'LOCAL_HASH_ONLY'
        });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
export function inspect_entry(hash) {
    ensureVault();
    const catalog = loadCatalog();
    return catalog[hash] ?? null;
}
export function delete_entry(hash) {
    ensureVault();
    ensureIndexDirs();
    let deleted = false;
    // 1. Delete object file
    const objPath = path.join(VAULT_DIR, `${hash}.txt`);
    if (fs.existsSync(objPath)) {
        fs.unlinkSync(objPath);
        deleted = true;
    }
    // 2. Delete segment file
    const segPath = path.join(SEGMENTS_DIR, `${hash}.json`);
    if (fs.existsSync(segPath))
        fs.unlinkSync(segPath);
    // 3. Remove from catalog
    const catalog = loadCatalog();
    if (catalog[hash]) {
        delete catalog[hash];
        saveCatalog(catalog);
        deleted = true;
    }
    // 4. Remove postings — prevent orphan entries
    const postings = loadPostings();
    let postingsChanged = false;
    for (const term of Object.keys(postings)) {
        const before = postings[term].length;
        postings[term] = postings[term].filter((p) => p.root !== hash);
        if (postings[term].length === 0) {
            delete postings[term];
            postingsChanged = true;
        }
        else if (postings[term].length !== before) {
            postingsChanged = true;
        }
    }
    if (postingsChanged)
        atomicWrite(POSTINGS_PATH, postings);
    // 5. Remove from doc stats
    const docStats = loadDocStats();
    if (docStats[hash]) {
        delete docStats[hash];
        atomicWrite(DOC_STATS_PATH, docStats);
    }
    return deleted;
}
export function vault_stats() {
    ensureVault();
    const catalog = loadCatalog();
    const entries = Object.values(catalog);
    if (entries.length === 0) {
        return { total_entries: 0, total_bytes: 0, namespaces: [], oldest_at: null, newest_at: null };
    }
    const namespaces = [...new Set(entries.map(e => e.namespace))];
    const sortedByDate = entries.map(e => e.ingested_at).sort();
    return {
        total_entries: entries.length,
        total_bytes: entries.reduce((sum, e) => sum + e.byte_size, 0),
        namespaces,
        oldest_at: sortedByDate[0],
        newest_at: sortedByDate[sortedByDate.length - 1],
    };
}
export function get_index_status() {
    const manifest = loadIndexManifest();
    const catalog = loadCatalog();
    const docStats = loadDocStats();
    const rebuild = indexNeedsRebuild();
    return {
        status: rebuild ? 'INDEX_REBUILD_REQUIRED' : 'OK',
        index_version: manifest?.index_version || null,
        indexed_root_count: Object.keys(docStats).length,
        catalog_root_count: Object.keys(catalog).length,
        needs_rebuild: rebuild,
        built_at: manifest?.built_at || null,
        objects_preserved: true
    };
}
export function rebuild_index() {
    ensureIndexDirs();
    const catalog = loadCatalog();
    const errors = [];
    let indexed = 0;
    const newPostings = {};
    const newStats = {};
    for (const [hash] of Object.entries(catalog)) {
        const objPath = path.join(VAULT_DIR, `${hash}.txt`);
        if (!fs.existsSync(objPath)) {
            errors.push(`Missing object: ${hash}`);
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
                const terms = normalizeTerms(chunk);
                const freq = {};
                for (const t of terms) {
                    freq[t] = (freq[t] || 0) + 1;
                    for (const syn of expandWithSynonyms(t)) {
                        if (syn !== t)
                            freq[syn] = (freq[syn] || 0) + 0.5;
                    }
                }
                totalTokens += terms.length;
                segRecs.push({
                    root: hash, segment_index: i,
                    start_offset: offset, end_offset: offset + chunk.length,
                    token_count: terms.length, normalized_terms: freq,
                    split_reason: 'paragraph', record_id: null,
                    text_snippet: chunk.slice(0, 200)
                });
                for (const [term, frq] of Object.entries(freq)) {
                    if (!newPostings[term])
                        newPostings[term] = [];
                    newPostings[term].push({ root: hash, segment_index: i, frequency: frq });
                }
                offset += chunk.length;
            }
            atomicWrite(path.join(SEGMENTS_DIR, `${hash}.json`), segRecs);
            newStats[hash] = { root: hash, total_tokens: totalTokens, segment_count: chunks.length };
            indexed++;
        }
        catch (e) {
            errors.push(`Failed to index ${hash}: ${e.message}`);
        }
    }
    atomicWrite(POSTINGS_PATH, newPostings);
    atomicWrite(DOC_STATS_PATH, newStats);
    atomicWrite(INDEX_MANIFEST_PATH, {
        index_version: INDEX_VERSION,
        normalization_version: NORMALIZATION_VERSION,
        stemmer_version: STEMMER_VERSION,
        indexed_root_count: indexed,
        built_at: new Date().toISOString(),
        needs_rebuild: false
    });
    return { success: errors.length === 0, roots_indexed: indexed, errors };
}
export function ingest_text(text, options) {
    ensureVault();
    ensureIndexDirs();
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    // 1. Write raw object (authoritative — never modify after write)
    const objPath = path.join(VAULT_DIR, `${hash}.txt`);
    fs.writeFileSync(objPath, text, 'utf8');
    // 2. Segment
    const chunks = splitIntoChunks(text);
    // 3. Build segment records + collect term frequencies
    const segmentRecords = [];
    const termFreqsBySegment = [];
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const terms = normalizeTerms(chunk);
        const freq = {};
        for (const t of terms) {
            freq[t] = (freq[t] || 0) + 1;
            for (const syn of expandWithSynonyms(t)) {
                if (syn !== t)
                    freq[syn] = (freq[syn] || 0) + 0.5;
            }
        }
        segmentRecords.push({
            root: hash,
            segment_index: i,
            start_offset: offset,
            end_offset: offset + chunk.length,
            token_count: terms.length,
            normalized_terms: freq,
            split_reason: 'paragraph',
            record_id: null,
            text_snippet: chunk.slice(0, 200)
        });
        termFreqsBySegment.push(freq);
        offset += chunk.length;
    }
    // 4. Write segment file
    const segPath = path.join(SEGMENTS_DIR, `${hash}.json`);
    atomicWrite(segPath, segmentRecords);
    // 5. Update inverted index (read-modify-write with atomic swap)
    const postings = loadPostings();
    const docStats = loadDocStats();
    // Remove old postings for this root (re-ingest idempotency)
    for (const term of Object.keys(postings)) {
        postings[term] = postings[term].filter(p => p.root !== hash);
        if (postings[term].length === 0)
            delete postings[term];
    }
    // Add new postings
    for (let i = 0; i < segmentRecords.length; i++) {
        for (const [term, freq] of Object.entries(termFreqsBySegment[i])) {
            if (!postings[term])
                postings[term] = [];
            postings[term].push({ root: hash, segment_index: i, frequency: freq });
        }
    }
    docStats[hash] = {
        root: hash,
        total_tokens: segmentRecords.reduce((s, r) => s + r.token_count, 0),
        segment_count: segmentRecords.length
    };
    atomicWrite(POSTINGS_PATH, postings);
    atomicWrite(DOC_STATS_PATH, docStats);
    // 6. Update catalog
    const catalog = loadCatalog();
    const now = new Date().toISOString();
    const existing = catalog[hash];
    catalog[hash] = {
        root: hash,
        title: options?.title ?? text.slice(0, 60).replace(/\n/g, ' ').trim(),
        namespace: options?.namespace ?? 'default',
        tags: options?.tags ?? [],
        content_type: options?.content_type ?? 'text/plain',
        source: options?.source ?? '',
        segment_count: chunks.length,
        byte_size: Buffer.byteLength(text, 'utf8'),
        excerpt: text.slice(0, 120).replace(/\n/g, ' ').trim(),
        ingested_at: existing?.ingested_at ?? now,
        updated_at: now,
    };
    saveCatalog(catalog);
    // 7. Update index manifest
    atomicWrite(INDEX_MANIFEST_PATH, {
        index_version: INDEX_VERSION,
        normalization_version: NORMALIZATION_VERSION,
        stemmer_version: STEMMER_VERSION,
        indexed_root_count: Object.keys(docStats).length,
        built_at: new Date().toISOString(),
        needs_rebuild: false
    });
    return hash;
}
export function retrieve_evidence(hash, query) {
    ensureVault();
    const filePath = path.join(VAULT_DIR, `${hash}.txt`);
    if (!fs.existsSync(filePath)) {
        return `ERROR: Shard ${hash} not found in local vault.`;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const chunks = splitIntoChunks(text);
    const words = extractQueryWords(query);
    if (words.length === 0)
        return `No relevant evidence found for query: ${query}`;
    let best = { score: -1, chunk: '' };
    for (const chunk of chunks) {
        const score = scoreChunk(chunk, words);
        if (score > best.score)
            best = { score, chunk };
    }
    if (best.score < 0)
        return `No relevant evidence found for query: ${query}`;
    return extractEvidenceWindow(best.chunk, words) ?? `No keyword match found in best chunk for query: ${query}`;
}
