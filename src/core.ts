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

function stripFormatSpecifiers(text: string): string {
  return text.replace(FORMAT_SPECIFIER_RE, '').trim();
}

function extractQueryWords(text: string): string[] {
  return stripFormatSpecifiers(text)
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Document Intelligence Layer — Staged Compression Path
const CHUNK_TARGET_SIZE = 1800; // chars per chunk for initial segmentation
const EVIDENCE_WINDOW    = 900;  // chars surrounding the best keyword match

// Fuzzy word match — same ≥75% shared-leading-chars rule already used by
// scoreField() for the structured-JSON path. Plain substring matching missed
// "smoking"/"smoker"/"smokes" when the query word was "smoke" (verified: a
// 2026-07-11 benchmark found 8/30 free-text "does the patient smoke" queries
// returned not_found even though the source note stated smoking status,
// because "smoking".includes("smoke") === false while "smoker"/"smokes" do
// — plain substring search is inconsistent across trivial English inflections
// of the same word). This makes the free-text path use the same matching
// standard the JSON path already had.
function stem(word: string): string {
  if (word.length <= 3) return word;
  const suffixes = ['ations', 'ation', 'ings', 'ing', 'ness', 'ment', 'ated', 'ating', 'ers', 'er', 'ed', 'es', 's'];
  for (const sfx of suffixes) {
    if (word.endsWith(sfx) && word.length - sfx.length >= 3) {
      return word.slice(0, word.length - sfx.length);
    }
  }
  return word;
}

function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Stem both words; if stems match, words are considered equivalent
  if (stem(a) === stem(b)) return true;
  // Prefix ratio fallback (short words require exact match)
  if (a.length < 4 || b.length < 4) return false;
  const minLen = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < minLen && a[shared] === b[shared]) shared++;
  return shared / minLen >= 0.75;
}

function tokenizeWords(text: string): { word: string; pos: number }[] {
  const out: { word: string; pos: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ word: m[0], pos: m.index });
  }
  return out;
}

function splitIntoChunks(text: string): string[] {
  if (!text || !text.trim()) return [];
  const MAX = CHUNK_TARGET_SIZE;

  function packPieces(pieces: string[], max: number): string[] {
    const chunks: string[] = [];
    let cur = '';
    for (const piece of pieces) {
      if (piece.length > max) {
        if (cur) { chunks.push(cur.trim()); cur = ''; }
        for (let i = 0; i < piece.length; i += max) chunks.push(piece.slice(i, i + max));
      } else {
        const joined = cur ? cur + ' ' + piece : piece;
        if (joined.length > max) {
          if (cur) chunks.push(cur.trim());
          cur = piece;
        } else {
          cur = joined;
        }
      }
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks;
  }

  function shatter(segment: string): string[] {
    if (segment.length <= MAX) return [segment];
    // Level 2: sentence boundaries
    const sentences = segment.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
      ?.map(s => s.trim()).filter(s => s.length > 0) ?? [];
    if (sentences.length > 1) return packPieces(sentences, MAX);
    // Level 3: word boundaries
    const words = segment.split(/\s+/).filter(w => w.length > 0);
    if (words.length > 1) return packPieces(words, MAX);
    // Level 4: hard cut (minified text, no whitespace)
    const out: string[] = [];
    for (let i = 0; i < segment.length; i += MAX) out.push(segment.slice(i, i + MAX));
    return out;
  }

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 0);
  return paragraphs.flatMap(para => shatter(para).filter(piece => piece.trim().length > 0));
}

function scoreChunk(chunk: string, queryWords: string[]): number {
  const chunkWords = tokenizeWords(chunk.toLowerCase());
  let score = 0;
  for (const w of queryWords) {
    for (const cw of chunkWords) {
      if (wordsMatch(w, cw.word)) score++;
    }
  }
  return score;
}

// Extract the 900-char window centered on the highest-density keyword match.
// Returns null if no keyword is found in the chunk.
function extractEvidenceWindow(chunk: string, queryWords: string[]): string | null {
  const lower = chunk.toLowerCase();
  const chunkWords = tokenizeWords(lower);
  let bestPos = -1;

  for (const w of queryWords) {
    const hit = chunkWords.find(cw => wordsMatch(w, cw.word));
    const pos = hit ? hit.pos : -1;
    if (pos !== -1 && bestPos === -1) bestPos = pos;
    // Prefer the position with the most surrounding hits (density center)
    if (pos !== -1) {
      const half = Math.floor(EVIDENCE_WINDOW / 2);
      const wStart = Math.max(0, pos - half);
      const wEnd   = Math.min(lower.length, pos + half);
      const windowWords = chunkWords.filter(cw => cw.pos >= wStart && cw.pos < wEnd);
      const density = queryWords.reduce((sum, qw) => {
        return sum + windowWords.filter(cw => wordsMatch(qw, cw.word)).length;
      }, 0);
      // Always prefer the first hit as anchor; density used for tie-breaking
      if (bestPos === -1 || density > 1) bestPos = pos;
    }
  }

  if (bestPos === -1) return null;

  const half = Math.floor(EVIDENCE_WINDOW / 2);
  const start = Math.max(0, bestPos - half);
  const end   = Math.min(chunk.length, bestPos + half);
  return chunk.slice(start, end).trim();
}

// ── Local filesystem storage layer ────────────────────────────────────────────

const VAULT_DIR = path.join(os.homedir(), '.vanguard', 'local_vault');

function ensureVault(): void {
  fs.mkdirSync(VAULT_DIR, { recursive: true });
}


// ── Catalog types ────────────────────────────────────────────────────────────

interface CatalogEntry {
  root: string;
  title: string;
  namespace: string;
  tags: string[];
  content_type: string;
  source: string;
  segment_count: number;
  byte_size: number;
  excerpt: string;
  ingested_at: string;
  updated_at: string;
}

interface IngestOptions {
  title?: string;
  namespace?: string;
  tags?: string[];
  content_type?: string;
  source?: string;
}

const CATALOG_FILE = path.join(VAULT_DIR, 'catalog.json');

function loadCatalog(): Record<string, CatalogEntry> {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCatalog(catalog: Record<string, CatalogEntry>): void {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2), 'utf8');
}

export function list_vault(namespace?: string): CatalogEntry[] {
  ensureVault();
  const catalog = loadCatalog();
  const entries = Object.values(catalog);
  return namespace
    ? entries.filter(e => e.namespace === namespace)
    : entries;
}

export function search_vault(query: string, limit = 10): { entry: CatalogEntry; score: number; excerpt: string }[] {
  ensureVault();
  const catalog = loadCatalog();
  const words = extractQueryWords(query);
  if (words.length === 0) return [];
  const results: { entry: CatalogEntry; score: number; excerpt: string }[] = [];
  for (const entry of Object.values(catalog)) {
    const haystack = (entry.title + ' ' + entry.excerpt + ' ' + entry.tags.join(' ')).toLowerCase();
    const haystackWords = haystack.match(/[a-z0-9]+/g) ?? [];
    let score = 0;
    for (const w of words) {
      for (const hw of haystackWords) {
        if (wordsMatch(w, hw)) score++;
      }
    }
    if (score > 0) results.push({ entry, score, excerpt: entry.excerpt });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function inspect_entry(hash: string): CatalogEntry | null {
  ensureVault();
  const catalog = loadCatalog();
  return catalog[hash] ?? null;
}

export function delete_entry(hash: string): boolean {
  ensureVault();
  const catalog = loadCatalog();
  if (!catalog[hash]) return false;
  delete catalog[hash];
  saveCatalog(catalog);
  const filePath = path.join(VAULT_DIR, `${hash}.txt`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
}

export function vault_stats(): {
  total_entries: number;
  total_bytes: number;
  namespaces: string[];
  oldest_at: string | null;
  newest_at: string | null;
} {
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

export function ingest_text(text: string, options: IngestOptions = {}): string {
  ensureVault();
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const filePath = path.join(VAULT_DIR, `${hash}.txt`);
  fs.writeFileSync(filePath, text, 'utf8');
  const catalog = loadCatalog();
  const chunks = splitIntoChunks(text);
  const now = new Date().toISOString();
  const existing = catalog[hash];
  catalog[hash] = {
    root: hash,
    title: options.title ?? text.slice(0, 60).replace(/\n/g, ' ').trim(),
    namespace: options.namespace ?? 'default',
    tags: options.tags ?? [],
    content_type: options.content_type ?? 'text/plain',
    source: options.source ?? '',
    segment_count: chunks.length,
    byte_size: Buffer.byteLength(text, 'utf8'),
    excerpt: text.slice(0, 120).replace(/\n/g, ' ').trim(),
    ingested_at: existing?.ingested_at ?? now,
    updated_at: now,
  };
  saveCatalog(catalog);
  return hash;
}

export function retrieve_evidence(hash: string, query: string): string {
  ensureVault();
  const filePath = path.join(VAULT_DIR, `${hash}.txt`);
  if (!fs.existsSync(filePath)) {
    return `ERROR: Shard ${hash} not found in local vault.`;
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const chunks = splitIntoChunks(text);
  const words = extractQueryWords(query);
  if (words.length === 0) return `No relevant evidence found for query: ${query}`;
  let best = { score: -1, chunk: '' };
  for (const chunk of chunks) {
    const score = scoreChunk(chunk, words);
    if (score > best.score) best = { score, chunk };
  }
  if (best.score < 0) return `No relevant evidence found for query: ${query}`;
  return extractEvidenceWindow(best.chunk, words) ?? `No keyword match found in best chunk for query: ${query}`;
}
