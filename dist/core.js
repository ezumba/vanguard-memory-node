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
function wordsMatch(a, b) {
    if (a === b)
        return true;
    const minLen = Math.min(a.length, b.length);
    if (minLen < 3)
        return false; // too short for a fuzzy prefix ratio to mean anything
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
    const chunks = [];
    const paragraphs = text.split(/\n{2,}/);
    let current = '';
    for (const para of paragraphs) {
        if ((current + para).length > CHUNK_TARGET_SIZE && current) {
            chunks.push(current.trim());
            current = para;
        }
        else {
            current += (current ? '\n\n' : '') + para;
        }
    }
    if (current.trim().length > 50)
        chunks.push(current.trim());
    return chunks;
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
function ensureVault() {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
}
export function ingest_text(text) {
    ensureVault();
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const filePath = path.join(VAULT_DIR, `${hash}.txt`);
    fs.writeFileSync(filePath, text, 'utf8');
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
