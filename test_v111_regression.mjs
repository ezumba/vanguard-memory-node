#!/usr/bin/env node
import { createHash } from 'crypto';
import {
  ingest_text, retrieve_evidence, search_vault, delete_entry,
  get_index_status, rebuild_index, vault_stats
} from './dist/core.js';

let passed = 0;
let failed = 0;
const cleanup = [];

function assert(label, condition, actual) {
  if (condition) { console.log(`  PASS: ${label}`); passed++; }
  else { console.error(`  FAIL: ${label} — got: ${JSON.stringify(actual)}`); failed++; }
}

console.log('\n=== VMN v1.1.1 Regression Tests ===\n');

// ── A: Safety — no payment strings ──────────────────────────────────────────
console.log('Section A: Safety');
const h_safe = ingest_text('Test safety payload.');
cleanup.push(h_safe);
const r_safe = retrieve_evidence(h_safe, 'test');
assert('A1: No x402', !r_safe.includes('x402'), r_safe.slice(0,50));
assert('A2: No USDC', !r_safe.includes('USDC'), r_safe.slice(0,50));
assert('A3: No payment', !r_safe.toLowerCase().includes('payment'), r_safe.slice(0,50));

// ── B: Chunking ──────────────────────────────────────────────────────────────
console.log('\nSection B: Chunking');
const { default: { splitIntoChunks } } = await import('./dist/core.js').then(m => ({default: m}));
// Note: splitIntoChunks may not be exported — test via ingest behavior
const longBlob = 'x'.repeat(5000);
const h_long = ingest_text(longBlob);
cleanup.push(h_long);
const stats_long = (await import('./dist/core.js')).inspect_entry(h_long);
assert('B1: 5000-char blob segments > 1', (stats_long?.segment_count ?? 0) > 1, stats_long?.segment_count);

// ── C: Morphological matching ────────────────────────────────────────────────
console.log('\nSection C: Stemming & Morphology');
const smokeDoc = 'The patient is a smoker with a 10-year smoking history.';
const h_smoke = ingest_text(smokeDoc, {title: 'Smoking History'});
cleanup.push(h_smoke);

// Test via retrieve_evidence (uses same normalization)
const r1 = retrieve_evidence(h_smoke, 'smoking');
assert('C1: smoking matches', r1.toLowerCase().includes('smok'), r1.slice(0,60));
const r2 = retrieve_evidence(h_smoke, 'smoker');
assert('C2: smoker matches', r2.toLowerCase().includes('smok'), r2.slice(0,60));

// Test via search_vault (uses postings index)
const s1 = search_vault('smoking');
assert('C3: smoking discoverable via search', s1.some(r => r.root === h_smoke), s1.length);
const s2 = search_vault('smoker');
assert('C4: smoker discoverable via search', s2.some(r => r.root === h_smoke), s2.length);

// False positive guards
const genDoc = 'The power generator runs at full capacity.';
const h_gen = ingest_text(genDoc);
cleanup.push(h_gen);
const s_gen = search_vault('generic');
assert('C5: generic does not match generator', !s_gen.some(r => r.root === h_gen), s_gen.length);

const allergyDoc = 'Patient has allergic reactions to penicillin.';
const h_allergy = ingest_text(allergyDoc);
cleanup.push(h_allergy);
const s_all = search_vault('all');
assert('C6: all does not match allergic', !s_all.some(r => r.root === h_allergy), s_all.length);

// ── D: Body-deep term discovery (THE KEY v1.1.1 TEST) ────────────────────────
console.log('\nSection D: Full-Body Discovery');
const prefix = 'Meeting notes. Agenda items discussed at length. '.repeat(5);
const body   = 'The THROTTLE_BURST_OVERRIDE flag controls rate limiting.';
const h_throttle = ingest_text(prefix + body, {title: 'Meeting Notes'});
cleanup.push(h_throttle);

// Confirm term is past char 120
assert('D1: term is past excerpt boundary',
  (prefix + body).indexOf('THROTTLE_BURST_OVERRIDE') > 120,
  (prefix + body).indexOf('THROTTLE_BURST_OVERRIDE'));

const s_throttle = search_vault('THROTTLE_BURST_OVERRIDE');
assert('D2: body-deep term discoverable', s_throttle.some(r => r.root === h_throttle), s_throttle.length);
if (s_throttle.length > 0) {
  const hit = s_throttle.find(r => r.root === h_throttle);
  assert('D3: snippet contains the term', hit?.snippet?.includes('THROTTLE') || hit?.snippet?.includes('throttl'), hit?.snippet?.slice(0,80));
  assert('D4: matched_terms present', (hit?.matched_terms?.length ?? 0) > 0, hit?.matched_terms);
  assert('D5: score > 0', (hit?.score ?? 0) > 0, hit?.score);
}

// ── E: Delete purges postings ─────────────────────────────────────────────────
console.log('\nSection E: Delete + Index Cleanup');
const h_del = ingest_text('Delete test payload unique_delete_marker_xyz.');
const before = search_vault('unique_delete_marker_xyz');
assert('E1: term found before delete', before.some(r => r.root === h_del), before.length);
delete_entry(h_del);
const after = search_vault('unique_delete_marker_xyz');
assert('E2: term gone after delete', !after.some(r => r.root === h_del), after.length);

// ── F: Index rebuild ──────────────────────────────────────────────────────────
console.log('\nSection F: Index Rebuild');
const rebuild_result = rebuild_index();
assert('F1: rebuild succeeds', rebuild_result.success === true, rebuild_result);
assert('F2: no rebuild errors', rebuild_result.errors.length === 0, rebuild_result.errors);

const status = get_index_status();
assert('F3: status OK after rebuild', status.status === 'OK', status.status);
assert('F4: objects preserved', status.objects_preserved === true, status.objects_preserved);

// Verify body-deep term still findable after rebuild
const s_after_rebuild = search_vault('THROTTLE_BURST_OVERRIDE');
assert('F5: body-deep term still discoverable after rebuild',
  s_after_rebuild.some(r => r.root === h_throttle), s_after_rebuild.length);

// ── G: Determinism ────────────────────────────────────────────────────────────
console.log('\nSection G: Determinism');
const text = 'Determinism test.';
const hA = ingest_text(text);
const hB = ingest_text(text);
assert('G1: same text same hash', hA === hB, [hA.slice(0,8), hB.slice(0,8)]);
assert('G2: hash matches SHA-256', hA === createHash('sha256').update(text).digest('hex'), hA.slice(0,8));
cleanup.push(hA);

// Search is deterministic
const r_det1 = search_vault('determinism test');
const r_det2 = search_vault('determinism test');
assert('G3: search is deterministic',
  JSON.stringify(r_det1) === JSON.stringify(r_det2), 'scores differ');

// ── Cleanup ───────────────────────────────────────────────────────────────────
for (const h of [...new Set(cleanup)]) {
  try { delete_entry(h); } catch(e) {}
}
console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
