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

import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import * as os     from 'os';
import { NORMALIZATION_VERSION, STEMMER_VERSION, ALIAS_DICT_VERSION } from './normalization.js';

export const INDEX_VERSION    = 2;
export const VAULT_BASE       = path.join(os.homedir(), '.vanguard');
export const OBJECTS_DIR      = path.join(VAULT_BASE, 'local_vault');
export const SEGMENTS_DIR     = path.join(VAULT_BASE, 'segments');
export const CATALOG_DIR      = path.join(VAULT_BASE, 'catalog');
export const INDEX_V2_DIR     = path.join(VAULT_BASE, 'index', 'v2');
export const POSTINGS_DIR     = path.join(INDEX_V2_DIR, 'postings');
export const TRANSACTIONS_DIR = path.join(INDEX_V2_DIR, 'transactions');
export const RECOVERY_DIR     = path.join(INDEX_V2_DIR, 'recovery');
export const MANIFEST_PATH    = path.join(INDEX_V2_DIR, 'index_manifest.json');
export const CORPUS_STATS_PATH = path.join(INDEX_V2_DIR, 'corpus_stats.json');
// Legacy v1.1.1 catalog path (migration source)
export const LEGACY_CATALOG_PATH = path.join(OBJECTS_DIR, 'catalog.json');

export type IndexState =
  | 'READY'
  | 'REBUILDING'
  | 'DEGRADED'
  | 'REBUILD_REQUIRED'
  | 'MIGRATING';

export interface IndexManifest {
  index_version:             number;
  normalization_version:     string;
  stemmer_version:           string;
  alias_dictionary_version:  string;
  root_count:                number;
  segment_count:             number;
  generation:                number;
  state:                     IndexState;
  last_rebuilt_at:           string | null;
  last_transaction_id:       string | null;
}

export interface PostingEntry {
  root:          string;
  segment_index: number;
  frequency:     number;
}

export interface BucketFile {
  schema_version: number;
  bucket:         string;
  generation:     number;
  terms:          Record<string, PostingEntry[]>;
}

export interface SegmentRecord {
  root:             string;
  segment_index:    number;
  start_offset:     number;
  end_offset:       number;
  token_count:      number;
  term_frequencies: Record<string, number>;
  split_reason:     string;
  record_id:        string | null;
  snippet:          string;
}

export interface CatalogEntry {
  root:          string;
  title:         string;
  namespace:     string;
  tags:          string[];
  content_type:  string;
  size_bytes:    number;
  segment_count: number;
  ingested_at:   string;
  updated_at:    string;
  excerpt:       string;
}

export interface CorpusStats {
  total_roots:    number;
  total_tokens:   number;
  avg_doc_length: number;
  per_root:       Record<string, { total_tokens: number; segment_count: number }>;
}

// ── Directory setup ───────────────────────────────────────────────────────────
export function ensureIndexDirs(): void {
  for (const d of [OBJECTS_DIR, SEGMENTS_DIR, CATALOG_DIR, INDEX_V2_DIR, POSTINGS_DIR,
                   TRANSACTIONS_DIR, RECOVERY_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// ── Bucket routing ────────────────────────────────────────────────────────────
export function termBucket(normalizedTerm: string): string {
  return crypto.createHash('sha256').update(normalizedTerm).digest('hex').slice(0, 2);
}

export function bucketPath(bucket: string): string {
  return path.join(POSTINGS_DIR, `${bucket}.json`);
}

// ── Atomic write (safe on POSIX; near-atomic on Windows) ──────────────────────
export function atomicWrite(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  // Platform-safe rename
  if (process.platform === 'win32') {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  fs.renameSync(tmp, filePath);
}

// ── Manifest I/O ──────────────────────────────────────────────────────────────
export function loadManifest(): IndexManifest | null {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch (e) { /* fall through */ }
  return null;
}

export function saveManifest(manifest: IndexManifest): void {
  ensureIndexDirs();
  atomicWrite(MANIFEST_PATH, manifest);
}

export function indexState(): IndexState {
  const m = loadManifest();
  if (!m) return 'REBUILD_REQUIRED';
  if (m.index_version !== INDEX_VERSION) return 'REBUILD_REQUIRED';
  if (m.normalization_version !== NORMALIZATION_VERSION) return 'REBUILD_REQUIRED';
  return m.state || 'REBUILD_REQUIRED';
}

// ── Bucket I/O ────────────────────────────────────────────────────────────────
export function loadBucket(bucket: string): BucketFile {
  const bp = bucketPath(bucket);
  try {
    if (fs.existsSync(bp)) {
      return JSON.parse(fs.readFileSync(bp, 'utf8'));
    }
  } catch (e) { /* fall through */ }
  return { schema_version: 2, bucket, generation: 0, terms: {} };
}

export function loadBuckets(buckets: string[]): Map<string, BucketFile> {
  const result = new Map<string, BucketFile>();
  for (const b of buckets) {
    result.set(b, loadBucket(b));
  }
  return result;
}

// ── Corpus stats ──────────────────────────────────────────────────────────────
export function loadCorpusStats(): CorpusStats {
  try {
    if (fs.existsSync(CORPUS_STATS_PATH)) {
      return JSON.parse(fs.readFileSync(CORPUS_STATS_PATH, 'utf8'));
    }
  } catch (e) { /* fall through */ }
  return { total_roots: 0, total_tokens: 0, avg_doc_length: 0, per_root: {} };
}

// ── Segment I/O ───────────────────────────────────────────────────────────────
export function loadSegments(root: string): SegmentRecord[] {
  const p = path.join(SEGMENTS_DIR, `${root}.json`);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* fall through */ }
  return [];
}

// ── Catalog I/O ───────────────────────────────────────────────────────────────
export function loadCatalog(): Record<string, CatalogEntry> {
  // Try v2 catalog dir first
  const v2Cat: Record<string, CatalogEntry> = {};
  try {
    if (fs.existsSync(CATALOG_DIR)) {
      for (const f of fs.readdirSync(CATALOG_DIR)) {
        if (f.endsWith('.json')) {
          const entry = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8'));
          v2Cat[entry.root] = entry;
        }
      }
    }
  } catch (e) { /* fall through */ }

  // Fall back to legacy v1.1.1 catalog
  if (Object.keys(v2Cat).length === 0 && fs.existsSync(LEGACY_CATALOG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(LEGACY_CATALOG_PATH, 'utf8'));
    } catch (e) { /* fall through */ }
  }
  return v2Cat;
}

export function loadCatalogEntry(root: string): CatalogEntry | null {
  const p = path.join(CATALOG_DIR, `${root}.json`);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* fall through */ }
  return null;
}

export function loadCatalogEntries(roots: string[]): Record<string, CatalogEntry> {
  const result: Record<string, CatalogEntry> = {};
  for (const root of roots) {
    const entry = loadCatalogEntry(root);
    if (entry) result[root] = entry;
  }
  return result;
}

export function saveCatalogEntry(entry: CatalogEntry): void {
  ensureIndexDirs();
  atomicWrite(path.join(CATALOG_DIR, `${entry.root}.json`), entry);
}

export function deleteCatalogEntry(root: string): void {
  const p = path.join(CATALOG_DIR, `${root}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
