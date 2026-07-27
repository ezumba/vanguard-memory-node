// E6 regression suite for vanguard-memory-node v1.1.0
// Sections: A (safety), B (chunking), C (stemming), D (catalog/discovery), E (determinism)
import { ingest_text, retrieve_evidence, list_vault, search_vault, inspect_entry, delete_entry, vault_stats } from '/home/edt/vanguard_memory_node/dist/core.js';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const VAULT_DIR = path.join(os.homedir(), '.vanguard', 'local_vault');

let pass = 0, fail = 0, total = 0;
function assert(name, cond, detail) {
  total++;
  if (cond) { console.log('  PASS', name); pass++; }
  else { console.error('  FAIL', name, detail || ''); fail++; }
}

// ── Section A: Safety ─────────────────────────────────────────────────────────
console.log('\n=== A: Safety ===');

// A1: retrieve_evidence does not inject payment/upgrade strings into output
// Use text that doesn't mention any banned words so we isolate whether the
// function itself injects them into metadata/footers.
const h1 = ingest_text('Clinical record: blood pressure 130/85, no acute findings.', { namespace: 'reg-test' });
const ev1 = retrieve_evidence(h1, 'blood pressure');
assert('A1: no x402 in retrieve_evidence output', !ev1.includes('x402'));
assert('A1: no USDC in retrieve_evidence output', !ev1.includes('USDC'));
assert('A1: no LNES-04 in retrieve_evidence output', !ev1.includes('LNES-04'));
assert('A1: no Sovereign in retrieve_evidence output', !ev1.includes('Sovereign'));
assert('A1: no ZK-STARK in retrieve_evidence output', !ev1.includes('ZK-STARK'));
assert('A1: no upgrade prompt in retrieve_evidence output', !ev1.includes('upgrade'));
delete_entry(h1);

// A2: Missing hash returns ERROR not crash
const ev2 = retrieve_evidence('0'.repeat(64), 'anything');
assert('A2: missing hash returns ERROR string', ev2.startsWith('ERROR'));

// A3: Empty text ingests and retrieves without crash
const h3 = ingest_text('', { namespace: 'reg-test' });
assert('A3: empty text ingest returns hash', typeof h3 === 'string' && h3.length === 64);
delete_entry(h3);

// ── Section B: Chunking ───────────────────────────────────────────────────────
console.log('\n=== B: Chunking ===');

// B1: Two paragraphs each ~500 chars → 2 chunks
const p500 = 'word '.repeat(100);
const h_b1 = ingest_text(p500 + '\n\n' + p500, { namespace: 'reg-test', title: 'B1 two paras' });
const entry_b1 = inspect_entry(h_b1);
assert('B1: two paragraphs produce 2 segments', entry_b1?.segment_count === 2, 'got ' + entry_b1?.segment_count);
delete_entry(h_b1);

// B2: Single large paragraph (>1800 chars) → multiple chunks
const bigPara = 'This is a sentence for chunking test. '.repeat(60);
const h_b2 = ingest_text(bigPara, { namespace: 'reg-test', title: 'B2 large para' });
const entry_b2 = inspect_entry(h_b2);
assert('B2: large paragraph produces >1 segment', (entry_b2?.segment_count ?? 0) > 1, 'got ' + entry_b2?.segment_count);
delete_entry(h_b2);

// B3: Minified blob (no whitespace, 5000 chars) → multiple segments
const blob = 'x'.repeat(5000);
const h_b3 = ingest_text(blob, { namespace: 'reg-test', title: 'B3 blob' });
const entry_b3 = inspect_entry(h_b3);
assert('B3: blob segments > 1', (entry_b3?.segment_count ?? 0) > 1, 'got ' + entry_b3?.segment_count);
const ev_b3 = retrieve_evidence(h_b3, 'xxx');
assert('B3: recall on blob does not crash', typeof ev_b3 === 'string');
delete_entry(h_b3);

// B4: Empty string → 0 segments
const h_b4 = ingest_text('', { namespace: 'reg-test', title: 'B4 empty' });
const entry_b4 = inspect_entry(h_b4);
assert('B4: empty text produces 0 segments', entry_b4?.segment_count === 0, 'got ' + entry_b4?.segment_count);
delete_entry(h_b4);

// B5: Short text → 1 chunk
const h_b5 = ingest_text('Short text.', { namespace: 'reg-test', title: 'B5 short' });
const entry_b5 = inspect_entry(h_b5);
assert('B5: short text produces 1 segment', entry_b5?.segment_count === 1, 'got ' + entry_b5?.segment_count);
delete_entry(h_b5);

// ── Section C: Stemming ───────────────────────────────────────────────────────
console.log('\n=== C: Stemming ===');

// C1: smoking query finds smoker text
const smokingText = 'The subject is a smoker. History of tobacco use documented for three years.';
const h_c1 = ingest_text(smokingText, { namespace: 'reg-test', title: 'C1 smoking' });
const ev_c1 = retrieve_evidence(h_c1, 'smoking');
assert('C1: smoking query finds smoker text', !ev_c1.startsWith('ERROR') && !ev_c1.includes('No relevant'));
delete_entry(h_c1);

// C2: smoker query finds smoking text
const h_c2 = ingest_text('Patient has been smoking for ten years. Cessation counseled.', { namespace: 'reg-test', title: 'C2 smoker query' });
const ev_c2 = retrieve_evidence(h_c2, 'smoker');
assert('C2: smoker query finds smoking text', !ev_c2.startsWith('ERROR') && !ev_c2.includes('No relevant'));
delete_entry(h_c2);

// C3: generic ↛ generator (no false positive cross-stem match)
const h_c3 = ingest_text('This is a text about generic medications and formulary rules.', { namespace: 'reg-test', title: 'C3 generic' });
const ev_c3 = retrieve_evidence(h_c3, 'generator');
assert('C3: generator does not match generic', ev_c3.includes('No relevant') || ev_c3.includes('No keyword'));
delete_entry(h_c3);

// C4: all (stop word) → query words empty → no evidence returned
const h_c4 = ingest_text('Patient has allergies to penicillin and allergic reactions documented.', { namespace: 'reg-test', title: 'C4 allergic' });
const ev_c4 = retrieve_evidence(h_c4, 'all');
assert('C4: all (stop word) produces no evidence', ev_c4.includes('No relevant'), 'got: ' + ev_c4.slice(0, 80));
delete_entry(h_c4);

// ── Section D: Catalog / Discovery ───────────────────────────────────────────
console.log('\n=== D: Catalog/Discovery ===');

const ha = ingest_text('Alpha document about neural networks and deep learning architectures.', { namespace: 'ns-alpha', title: 'Alpha NN', tags: ['ai', 'ml'] });
const hb = ingest_text('Beta document about clinical trials and patient outcomes in oncology.', { namespace: 'ns-beta', title: 'Beta Clinical', tags: ['health'] });
const hc = ingest_text('Gamma document about financial modeling and risk analysis frameworks.', { namespace: 'ns-alpha', title: 'Gamma Finance', tags: ['finance'] });

const allEntries = list_vault();
assert('D1: list_vault has all 3', allEntries.filter(e => [ha, hb, hc].includes(e.root)).length === 3);

const alphaEntries = list_vault('ns-alpha');
assert('D2: ns-alpha filter returns 2', alphaEntries.filter(e => [ha, hc].includes(e.root)).length === 2);

const betaEntries = list_vault('ns-beta');
assert('D2: ns-beta filter returns 1', betaEntries.filter(e => e.root === hb).length === 1);

const searchResult = search_vault('neural networks learning');
assert('D3: search finds Alpha NN', searchResult.some(r => r.entry.root === ha));
assert('D3: Alpha NN is top result', searchResult.length > 0 && searchResult[0].entry.root === ha);

const inspectA = inspect_entry(ha);
assert('D4: inspect title', inspectA?.title === 'Alpha NN');
assert('D4: inspect namespace', inspectA?.namespace === 'ns-alpha');
assert('D4: inspect tags', JSON.stringify(inspectA?.tags) === '["ai","ml"]');

const hd = ingest_text('Delete me test document.', { namespace: 'reg-test', title: 'Delete Me' });
assert('D5: entry present before delete', inspect_entry(hd) !== null);
const delResult = delete_entry(hd);
assert('D5: delete returns true', delResult);
assert('D5: entry absent after delete', inspect_entry(hd) === null);
assert('D5: file absent after delete', !fs.existsSync(path.join(VAULT_DIR, `${hd}.txt`)));
assert('D5: second delete returns false', delete_entry(hd) === false);

const stats = vault_stats();
assert('D6: stats total_entries >= 3', stats.total_entries >= 3);
assert('D6: stats namespaces includes ns-alpha', stats.namespaces.includes('ns-alpha'));
assert('D6: stats namespaces includes ns-beta', stats.namespaces.includes('ns-beta'));
assert('D6: stats total_bytes > 0', stats.total_bytes > 0);

delete_entry(ha); delete_entry(hb); delete_entry(hc);

// ── Section E: Determinism ────────────────────────────────────────────────────
console.log('\n=== E: Determinism ===');

const text_e1 = 'Determinism test: the quick brown fox jumps over the lazy dog.';
const h_e1a = ingest_text(text_e1, { namespace: 'reg-test', title: 'Det A' });
const h_e1b = ingest_text(text_e1, { namespace: 'reg-test', title: 'Det B' });
assert('E1: same text → same hash', h_e1a === h_e1b);

const expected = crypto.createHash('sha256').update(text_e1).digest('hex');
assert('E2: hash is SHA-256 of text', h_e1a === expected);

const entry_e1a = inspect_entry(h_e1a);
const ingested_at_orig = entry_e1a?.ingested_at;
await new Promise(r => setTimeout(r, 10));
ingest_text(text_e1, { namespace: 'reg-test', title: 'Det C' });
const entry_e1b = inspect_entry(h_e1a);
assert('E3: ingested_at preserved on re-ingest', entry_e1b?.ingested_at === ingested_at_orig);
assert('E3: updated_at is set', typeof entry_e1b?.updated_at === 'string');

delete_entry(h_e1a);

const h_e4 = ingest_text('The patient reports chest pain and shortness of breath. Vital signs stable.', { namespace: 'reg-test' });
const ev_e4a = retrieve_evidence(h_e4, 'chest pain');
const ev_e4b = retrieve_evidence(h_e4, 'chest pain');
assert('E4: retrieve_evidence is deterministic', ev_e4a === ev_e4b);
delete_entry(h_e4);

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\nE6 Regression Results: ${pass}/${total} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
