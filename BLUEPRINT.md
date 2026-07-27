# VMN System Blueprint — v1.4.0

Architecture, design decisions, and invariants for contributors and integrators.

---

## 1. Core design principles

**Content-addressed, append-only objects.** Every ingested text is written to `~/.vanguard/local_vault/<sha256>.txt` exactly once. The file is never modified after initial write. The SHA-256 hash of the raw text is the permanent identity of that object across all subsystems. Overwriting a hash with different content is structurally impossible.

**Index is derived state.** The BM25 inverted index, segment records, and corpus stats are all reproducible from the object files alone. They are disposable. If any index file is corrupted, `vmn_rebuild_index` regenerates everything from the authoritative `.txt` files without data loss.

**Deterministic retrieval.** The normalization pipeline is versioned (`NORMALIZATION_VERSION`, `STEMMER_VERSION`, `ALIAS_DICT_VERSION`). Any change to any pipeline component increments the relevant version constant, which causes `indexState()` to return `REBUILD_REQUIRED` and triggers automatic synchronous rebuild on next use. Same query on same data always returns the same ranked result.

**No embeddings, no vectors, no external inference.** All retrieval is lexical. There is no dependency on any language model, embedding API, or similarity metric that could change behavior across versions.

---

## 2. Normalization pipeline

Applied identically at ingest time (to build the index) and at query time (to match against it).

```
Raw text
  → Unicode NFC normalization
  → Phrase alias substitution  (multi-word, longest-match-first)
  → Tokenize                   (split on whitespace/punctuation, min length 2)
  → Per-token: stemToken()
  → Stop-word filter
  → Token alias expansion      (synonym cluster lookup)
  → Deduplicated term set
```

### 2.1 Stemmer rules (STEMMER_VERSION 1.3.3)

Applied in priority order — first matching rule wins:

| Suffix | Min word length | Strips | Example |
|--------|----------------|--------|---------|
| `tions` | > 6 | 5 | medications → medica |
| `ions`  | > 5 | 4 | billions → bill |
| `tion`  | > 5 | 4 | medication → medica |
| `ings`  | > 6 | 4 | meetings → meet |
| `ing`   | > 6 | 3 | smoking → smok |
| `ers`   | > 5 | 3 | smokers → smok |
| `sion`  | > 8 | 3 | extension → extens |
| `ies`   | > 5 | 3 | allergies → allerg |
| `ic`    | > 6 | 2 | allergic → allerg |
| `er`    | > 4 | 2 | smoker → smok |
| `ed`    | > 4 | 2 | smoked → smok |
| `es`    | > 4 | 2 | smokes → smok |
| `s`     | > 3 | 1 | drugs → drug |
| `y`     | > 5 | 1 | allergy → allerg |

Critical invariant: `stemToken('medications') === stemToken('medication')` — the `tions` rule (strips 5) was added in v1.3.3 specifically to unify plural `-tions` forms with their singular `-tion` counterparts. The regression suite asserts this with `assert.strictEqual` as a hard pre-flight crash gate.

### 2.2 Phrase aliases (ALIAS_DICT_VERSION 1.2.1)

Multi-word phrases are substituted before tokenization, longest match first:

| Phrase | Canonical |
|--------|-----------|
| high blood pressure | hypertension |
| blood pressure | bp |
| tobacco use disorder | smoking |
| tobacco use | smoking |
| smoking history | smoking |
| primary care physician | doctor |
| general practitioner | doctor |
| myocardial infarction | heartattack |
| heart attack | heartattack |
| shortness of breath | dyspnea |
| chest pain / cardiac pain | cardiacpain |
| blood sugar / blood glucose | glucose |
| type 1/2 diabetes | diabetes |
| rate limit / rate limiting | ratelimit |
| memory leak | memoryleak |
| out of memory | oom |
| null pointer | nullref |
| stack overflow | stackoverflow |
| force majeure | forcemajeure |
| intellectual property | ip |

### 2.3 Token aliases

Applied after stemming. Each stem expands to its synonym cluster so both the stored term and the query term reach a shared canonical form.

Key clusters: `smok ↔ tobacco ↔ cigarett ↔ nicotine`, `physician ↔ doctor ↔ dr`, `hypertens ↔ bp`, `heartattack ↔ mi ↔ myocardi`, `dyspnea ↔ sob ↔ breathless`, `glucose ↔ bloodsugar ↔ bgl`, `ratelimit ↔ throttl ↔ burst`.

`generic` has no aliases — this is intentional to preserve the false-positive guard (regression case 4).

---

## 3. Sharded BM25 index

### 3.1 Structure

```
index/v2/postings/<2-hex-byte>.json   (256 files)
index/v2/corpus_stats.json
index/v2/index_manifest.json
```

Each posting bucket file:

```json
{
  "schema_version": 2,
  "bucket": "a3",
  "generation": 42,
  "terms": {
    "<stemmed-term>": [
      { "root": "<sha256>", "segment_index": 0, "frequency": 3.5 }
    ]
  }
}
```

Bucket routing: `bucket = sha256(normalizedTerm).slice(0, 2)`. A query for N unique terms touches at most N of the 256 bucket files — no full index scan.

### 3.2 BM25 parameters

```
k1 = 1.5
b  = 0.75
```

IDF uses the smoothed Robertson formula: `log(1 + (N - df + 0.5) / (df + 0.5))`.

High-DF cap: `MAX_POSTINGS_PER_TERM = 150`. If a term appears in more than 150 postings, only the 150 with highest frequency are scored. True DF (full count) is still used for IDF accuracy.

### 3.3 Segment scoring in `retrieve_evidence`

1. **Primary:** sum `frequency × 2` for each query term found in segment's `term_frequencies`.
2. **Fallback (score = 0 only):** tokenize chunk text, stem each token, check if any query term stem is in that set. Adds `0.5` if matched.
3. **Zero-score rejection:** if `bestScore <= 0` after all chunks, return `'no_relevant_evidence_found'` sentinel.

The fallback exists to catch cases where a term appears in text but wasn't indexed under the exact stem (e.g., uppercase-only tokens, edge tokenization). It never fires when BM25 already scored the segment.

### 3.4 Version invalidation

`indexState()` checks all four version constants against the manifest:

```typescript
if (m.index_version              !== INDEX_VERSION)         return 'REBUILD_REQUIRED';
if (m.normalization_version      !== NORMALIZATION_VERSION)  return 'REBUILD_REQUIRED';
if (m.alias_dictionary_version   !== ALIAS_DICT_VERSION)     return 'REBUILD_REQUIRED';
if (m.stemmer_version            !== STEMMER_VERSION)        return 'REBUILD_REQUIRED';
```

When `REBUILD_REQUIRED` and vault size ≤ `SMALL_VAULT_THRESHOLD` (1,000,000 roots), rebuild is synchronous before search continues. Above threshold: returns explicit `REBUILDING` state rather than silently returning empty results.

---

## 4. Text segmentation

Hierarchical chunker with 1800-character target:

1. Split on double-newlines (`\n\n`) into paragraphs.
2. If a paragraph exceeds 1800 chars, split on sentence boundaries (`/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g`).
3. If sentence splitting still exceeds, split on whitespace (words).
4. Hard fallback: slice at 1800 chars.

**Known edge case:** the sentence regex requires that a sentence-ending period be followed by whitespace or end-of-string. Periods inside version numbers (`v2.3.1`) or URLs don't satisfy this and cause the preceding text to be absorbed into the next sentence. Mitigate by using `\n\n` to isolate paragraphs containing version numbers.

Evidence window: 900-char window centered on the first prefix match of any query term found in the best-scoring chunk.

---

## 5. Storage operations

### 5.1 Atomic writes

All JSON files are written via:

```
serialize → in-memory JSON.parse (validation) → writeFileSync tmp → renameSync
```

On Windows: `unlinkSync` before `renameSync` (Windows cannot atomically replace an existing file via rename).

### 5.2 Catalog

Per-object catalog entries live at `~/.vanguard/catalog/<sha256>.json`. All catalog reads in hot paths (`search_vault`, `list_vault`) use `loadCatalogEntry(root)` (O(1) single-file read) or `loadCatalogEntries(roots[])` (reads only matched roots). The legacy `loadCatalog()` (full directory scan) is only used in `rebuild_index` and `vault_stats`.

### 5.3 Ingest idempotency

Re-ingesting identical text is safe. The object file is overwritten (same content, same hash). Old postings for that root are stripped from all affected buckets before new postings are written. Catalog `ingested_at` is preserved from the first ingest; `updated_at` is refreshed.

---

## 6. Vault bridge (ExergyNet LNES-17)

`src/vault_bridge.ts` provides optional sync to the ExergyNet thermodynamic ledger.

```typescript
syncToVault(payload: string, intent: string): Promise<SyncResult>
readVaultObject(root: string): string | null
```

**Auth:** `Authorization: Bearer ${EXERGYNET_API_KEY}` header.  
**Endpoint:** `${EXERGYNET_VAULT_URL}/api/xlmp/ingest` (default: `https://explorer-api.exergynet.org/api/xlmp/ingest`).  
**Body:** `{ payload: string, intent: string }`.

Safe no-op when `EXERGYNET_API_KEY` is absent — returns `{ status: 'unconfigured' }` without throwing.

Auto-sync trigger: `AUTO_SYNC_VAULT=true` env var causes `vmn_ingest` to call `syncToVault` after local persistence completes. The sync is awaited; `vault_synced: true/false` is included in the tool response.

Manual sync: `vmn_sync_vault` tool reads the raw object file and transmits it, returning the server's Canonical Manifest JSON.

---

## 7. Regression gate

`tests/regression_suite.mjs` — 19 cases, must all pass before any release.

| Case | What it covers |
|------|----------------|
| 1–3 | smoke / smoker / smoking / smokes cross-stem matching |
| 4 | generic MUST NOT match generator (false-positive guard) |
| 5 | medications → medication stem parity |
| 6 | lisinopril direct match |
| 7–8 | allergic ↔ allergies ↔ allergy cross-stem |
| 9 | apply MUST NOT match app |
| 10 | THROTTLE_BURST_OVERRIDE deep in 25KB body |
| 11 | zero-score → `no_relevant_evidence_found` sentinel |
| 12 | sentinel → human-readable translation |
| 13 | tobacco → smok alias (cross-alias) |
| 14 | allergies → allergic reverse stem |
| 15 | high-DF search latency < 50ms |
| 16 | `syncToVault` returns `ok` on mocked success |
| 17 | `Authorization` header is `Bearer <key>` |
| 18 | request body has correct `payload` and `intent` |
| 19 | `syncToVault` returns `unconfigured` when API key absent |

Pre-flight assertions (crash gate before case 1):
```javascript
assert.strictEqual(stemToken('medications'), stemToken('medication'))
assert.strictEqual(stemToken('mentions'),    stemToken('mention'))
assert.strictEqual(stemToken('actions'),     stemToken('action'))
```

Publish gate: `prepublishOnly` runs `npm run build && npm test` — a failing case aborts `npm publish` before any package uploads.

---

## 8. Version history

| Version | Change |
|---------|--------|
| 1.1.0 | Initial release — flat catalog, single-bucket index |
| 1.2.0 | Sharded BM25 index (256 buckets), unified normalization pipeline |
| 1.2.1 | Alias dictionary expansion (19 aliases), alias_coverage test suite |
| 1.3.0 | Performance: O(1) catalog reads, atomic write integrity, REBUILDING deadlock fix |
| 1.3.1 | Word-boundary fallback, sentinel formatting, version invalidation |
| 1.3.2 | Stemmed-token fallback replaces regex fallback, 15-case regression suite |
| 1.3.3 | `tions` stemmer rule (fixes medications≠medication parity), publish gate |
| 1.4.0 | ExergyNet vault bridge: `vmn_sync_vault`, `AUTO_SYNC_VAULT`, mock-fetch test cases |

---

## 9. Contributing

- OTET protocol: Observe → Think → Execute one change → Test → Report.
- `npm test` must show 19/19 before any PR.
- Stemmer changes require a new `assert.strictEqual` pre-flight and a STEMMER_VERSION bump.
- Object files (`.txt`) are authoritative and must never be modified or deleted by index operations.
- No embeddings, vector DB, payment integration, or external network calls may be added to the ingest or recall hot paths without explicit opt-in environment flags.
