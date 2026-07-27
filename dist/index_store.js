/**
 * index_store.ts — VMN v1.2.0
 * Sharded BM25 index storage engine.
 *
 * DESIGN:
 * - 256 posting buckets: bucket = sha256(normalizedTerm).slice(0,2)
 * - Each bucket file: index/v2/postings/<hex>.json
 * - Reads load ONLY buckets required by current query/document
 * - Writes touch ONLY buckets containing affected terms
 * - All writes are atomic (tmp -> rename)
 * - Index is derived state — never authoritative for object existence
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { NORMALIZATION_VERSION } from './normalization.js';
export const INDEX_VERSION = 2;
export const VAULT_BASE = path.join(os.homedir(), '.vanguard');
export const OBJECTS_DIR = path.join(VAULT_BASE, 'local_vault');
export const SEGMENTS_DIR = path.join(VAULT_BASE, 'segments');
export const CATALOG_DIR = path.join(VAULT_BASE, 'catalog');
export const INDEX_V2_DIR = path.join(VAULT_BASE, 'index', 'v2');
export const POSTINGS_DIR = path.join(INDEX_V2_DIR, 'postings');
export const TRANSACTIONS_DIR = path.join(INDEX_V2_DIR, 'transactions');
export const RECOVERY_DIR = path.join(INDEX_V2_DIR, 'recovery');
export const MANIFEST_PATH = path.join(INDEX_V2_DIR, 'index_manifest.json');
export const CORPUS_STATS_PATH = path.join(INDEX_V2_DIR, 'corpus_stats.json');
// Legacy v1.1.1 catalog path (migration source)
export const LEGACY_CATALOG_PATH = path.join(OBJECTS_DIR, 'catalog.json');
// ── Directory setup ───────────────────────────────────────────────────────────
export function ensureIndexDirs() {
    for (const d of [OBJECTS_DIR, SEGMENTS_DIR, CATALOG_DIR, INDEX_V2_DIR, POSTINGS_DIR,
        TRANSACTIONS_DIR, RECOVERY_DIR]) {
        fs.mkdirSync(d, { recursive: true });
    }
}
// ── Bucket routing ────────────────────────────────────────────────────────────
export function termBucket(normalizedTerm) {
    return crypto.createHash('sha256').update(normalizedTerm).digest('hex').slice(0, 2);
}
export function bucketPath(bucket) {
    return path.join(POSTINGS_DIR, `${bucket}.json`);
}
// ── Atomic write (safe on POSIX; near-atomic on Windows) ──────────────────────
export function atomicWrite(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    // Validate JSON before publishing
    JSON.parse(fs.readFileSync(tmp, 'utf8'));
    // Platform-safe rename
    if (process.platform === 'win32') {
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
    }
    fs.renameSync(tmp, filePath);
}
// ── Manifest I/O ──────────────────────────────────────────────────────────────
export function loadManifest() {
    try {
        if (fs.existsSync(MANIFEST_PATH)) {
            return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        }
    }
    catch (e) { /* fall through */ }
    return null;
}
export function saveManifest(manifest) {
    ensureIndexDirs();
    atomicWrite(MANIFEST_PATH, manifest);
}
export function indexState() {
    const m = loadManifest();
    if (!m)
        return 'REBUILD_REQUIRED';
    if (m.index_version !== INDEX_VERSION)
        return 'REBUILD_REQUIRED';
    if (m.normalization_version !== NORMALIZATION_VERSION)
        return 'REBUILD_REQUIRED';
    return m.state || 'REBUILD_REQUIRED';
}
// ── Bucket I/O ────────────────────────────────────────────────────────────────
export function loadBucket(bucket) {
    const bp = bucketPath(bucket);
    try {
        if (fs.existsSync(bp)) {
            return JSON.parse(fs.readFileSync(bp, 'utf8'));
        }
    }
    catch (e) { /* fall through */ }
    return { schema_version: 2, bucket, generation: 0, terms: {} };
}
export function loadBuckets(buckets) {
    const result = new Map();
    for (const b of buckets) {
        result.set(b, loadBucket(b));
    }
    return result;
}
// ── Corpus stats ──────────────────────────────────────────────────────────────
export function loadCorpusStats() {
    try {
        if (fs.existsSync(CORPUS_STATS_PATH)) {
            return JSON.parse(fs.readFileSync(CORPUS_STATS_PATH, 'utf8'));
        }
    }
    catch (e) { /* fall through */ }
    return { total_roots: 0, total_tokens: 0, avg_doc_length: 0, per_root: {} };
}
// ── Segment I/O ───────────────────────────────────────────────────────────────
export function loadSegments(root) {
    const p = path.join(SEGMENTS_DIR, `${root}.json`);
    try {
        if (fs.existsSync(p))
            return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch (e) { /* fall through */ }
    return [];
}
// ── Catalog I/O ───────────────────────────────────────────────────────────────
export function loadCatalog() {
    // Try v2 catalog dir first
    const v2Cat = {};
    try {
        if (fs.existsSync(CATALOG_DIR)) {
            for (const f of fs.readdirSync(CATALOG_DIR)) {
                if (f.endsWith('.json')) {
                    const entry = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
                    v2Cat[entry.root] = entry;
                }
            }
        }
    }
    catch (e) { /* fall through */ }
    // Fall back to legacy v1.1.1 catalog
    if (Object.keys(v2Cat).length === 0 && fs.existsSync(LEGACY_CATALOG_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(LEGACY_CATALOG_PATH, 'utf8'));
        }
        catch (e) { /* fall through */ }
    }
    return v2Cat;
}
export function saveCatalogEntry(entry) {
    ensureIndexDirs();
    atomicWrite(path.join(CATALOG_DIR, `${entry.root}.json`), entry);
}
export function deleteCatalogEntry(root) {
    const p = path.join(CATALOG_DIR, `${root}.json`);
    if (fs.existsSync(p))
        fs.unlinkSync(p);
}
