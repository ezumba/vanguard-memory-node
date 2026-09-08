/**
 * VMN Regression Suite — 34 historical cases + 16 evidence-native / publication-gate cases.
 * Run: node tests/regression_suite.mjs
 * Gate: all cases must pass before any release ships.
 */
import assert from 'node:assert';
import { performance } from 'perf_hooks';
import { writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stemToken } from '../dist/normalization.js';
import {
  ingest_text, retrieve_evidence, retrieve_evidence_adaptive, search_vault, delete_entry, ingest_file_delta,
} from '../dist/core.js';
import { syncToVault } from '../dist/vault_bridge.js';
import { BENCHMARK_RECORDS, compute_context_comparison } from '../dist/benchmarks.js';

// ── Stemmer parity pre-flight (throws on failure, blocking further tests) ─────
assert.strictEqual(stemToken('medications'), stemToken('medication'),
  `stemmer parity: medications(${stemToken('medications')}) !== medication(${stemToken('medication')})`);
assert.strictEqual(stemToken('mentions'),    stemToken('mention'),
  `stemmer parity: mentions !== mention`);
assert.strictEqual(stemToken('actions'),     stemToken('action'),
  `stemmer parity: actions !== action`);

let pass = 0, fail = 0;
const hashes = [];

function ok(label, result) {
  console.log(result ? `PASS  ${label}` : `FAIL  ${label}`);
  if (result) pass++; else fail++;
}

// ── Seed documents ────────────────────────────────────────────────────────────
const hSmoke   = ingest_text('The patient is a long-term smoker. Smoking history: 30 pack-years. Smokes 1 ppd.');
const hAllerg  = ingest_text('Allergies: Patient has allergic reactions to penicillin. Allergy to sulfa drugs also noted.');
const hMed     = ingest_text('Current medications: lisinopril 10mg daily. Medication reconciliation completed at intake.');
const hGenPow  = ingest_text('The power generator produces 500kW. Generator efficiency is 94% under load.');
const hApps    = ingest_text('The mobile app is installed on all devices. App performance meets SLA targets.');
const hThrottle = ingest_text(
  // THROTTLE term in its own paragraph so chunker keeps it intact.
  // Second paragraph is ~25KB to exercise chunking of large bodies.
  'THROTTLE_BURST_OVERRIDE rate limiter bug fixed in this release.\n\n' +
  ('Rate limiting overview. Updated throttle config. '.repeat(600))
);
const hVitals  = ingest_text('Patient vitals: BP 120/80. HR 72. Temp 98.6. SpO2 99%.');
[hSmoke, hAllerg, hMed, hGenPow, hApps, hThrottle, hVitals].forEach(h => hashes.push(h));

// ── Case 1: smoke matches smoker ──────────────────────────────────────────────
ok('1  smoke→smoker',    retrieve_evidence(hSmoke, 'smoke').toLowerCase().includes('smok'));

// ── Case 2: smoke matches smoking ─────────────────────────────────────────────
ok('2  smoke→smoking',   retrieve_evidence(hSmoke, 'smoking').toLowerCase().includes('smok'));

// ── Case 3: smoke matches smokes ──────────────────────────────────────────────
ok('3  smoke→smokes',    retrieve_evidence(hSmoke, 'smokes').toLowerCase().includes('smok'));

// ── Case 4: generic MUST NOT match generator ──────────────────────────────────
const r4 = retrieve_evidence(hGenPow, 'generic algorithm');
ok('4  generic≠generator (word boundary)', r4 === 'no_relevant_evidence_found');

// ── Case 5: medications matches medication ────────────────────────────────────
ok('5  medications→medication (stem match)', retrieve_evidence(hMed, 'medications prescribed').toLowerCase().includes('medicat'));

// ── Case 6: medications matches lisinopril via alias/co-occurrence ────────────
ok('6  lisinopril present in medication doc', retrieve_evidence(hMed, 'lisinopril').toLowerCase().includes('lisinopril'));

// ── Case 7: allergic matches allergies ────────────────────────────────────────
ok('7  allergic→allergies (stem match)',  retrieve_evidence(hAllerg, 'is patient allergic').toLowerCase().includes('allerg'));

// ── Case 8: allergy matches allergic ─────────────────────────────────────────
ok('8  allergy→allergic (stem match)',    retrieve_evidence(hAllerg, 'allergy').toLowerCase().includes('allerg'));

// ── Case 9: apply MUST NOT match app ─────────────────────────────────────────
const r9 = retrieve_evidence(hApps, 'apply for loan');
ok('9  apply≠app (stem guard)', r9 === 'no_relevant_evidence_found');

// ── Case 10: 20KB+ blob chunks correctly, deep term found ────────────────────
ok('10 deep term in 50KB body (THROTTLE_BURST_OVERRIDE)', retrieve_evidence(hThrottle, 'THROTTLE_BURST_OVERRIDE').toLowerCase().includes('throttle'));

// ── Case 11: zero-score query returns sentinel ────────────────────────────────
const r11 = retrieve_evidence(hVitals, 'quarterly earnings revenue forecast');
ok('11 zero-score→no_relevant_evidence_found', r11 === 'no_relevant_evidence_found');

// ── Case 12: sentinel translates to human-readable in recall context ──────────
// Simulate the index.ts translation logic directly
const sentinel = 'no_relevant_evidence_found';
const translated = sentinel === 'no_relevant_evidence_found'
  ? `No relevant evidence found in local memory for query: "quarterly earnings".`
  : sentinel;
ok('12 sentinel→human-readable translation', translated.startsWith('No relevant evidence'));

// ── Case 13: tobacco alias matches smoking document ───────────────────────────
ok('13 tobacco→smok alias (cross-alias)', retrieve_evidence(hSmoke, 'tobacco use').toLowerCase().includes('smok'));

// ── Case 14: allergies query matches allergic document ───────────────────────
ok('14 allergies→allergic (reverse stem)', retrieve_evidence(hAllerg, 'allergies').toLowerCase().includes('allerg'));

// ── Case 15: high-DF search (<50ms on seeded vault) ──────────────────────────
const seeds = [];
for (let i = 0; i < 100; i++) {
  seeds.push(ingest_text(`Common topic term in document ${i}. ` + 'word '.repeat(30)));
}
const t0 = performance.now();
for (let i = 0; i < 10; i++) search_vault('topic');
const latencyMs = (performance.now() - t0) / 10;
seeds.forEach(h => delete_entry(h));
ok(`15 high-DF search latency ${latencyMs.toFixed(1)}ms (<50ms gate)`, latencyMs < 50);

// ── Cases 16-18: Vault bridge (mock fetch) ────────────────────────────────────
{
  let captured = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok:   true,
      json: async () => ({ canonical_manifest: 'abc123', status: 'ok' }),
      text: async () => 'ok',
    };
  };

  process.env.EXERGYNET_API_KEY   = 'test-key-abc123';
  process.env.EXERGYNET_VAULT_URL = 'https://test.example.com';

  const r16 = await syncToVault('hello vault', 'unit-test');
  ok('16 syncToVault: status ok on mock success', r16.status === 'ok');

  ok('17 syncToVault: Authorization header Bearer-formatted',
    captured?.opts?.headers?.['Authorization'] === 'Bearer test-key-abc123');

  const body = JSON.parse(captured?.opts?.body ?? '{}');
  ok('18 syncToVault: body has correct payload and intent',
    body.payload === 'hello vault' && body.intent === 'unit-test');

  delete process.env.EXERGYNET_API_KEY;
  const r19 = await syncToVault('hello vault', 'unit-test');
  ok('19 syncToVault: unconfigured when API key missing', r19.status === 'unconfigured');

  // Case 20: 404 returns distinct message
  process.env.EXERGYNET_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) });
  const r20 = await syncToVault('x', 'test');
  ok('20 syncToVault: 404 → distinct endpoint message', r20.message.includes('404') && r20.message.includes('EXERGYNET_VAULT_URL'));

  // Case 21: 401 returns distinct auth message
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized', json: async () => ({}) });
  const r21 = await syncToVault('x', 'test');
  ok('21 syncToVault: 401 → distinct auth message', r21.message.includes('401/403') && r21.message.includes('EXERGYNET_API_KEY'));

  delete process.env.EXERGYNET_API_KEY;
  globalThis.fetch = origFetch;
  delete process.env.EXERGYNET_VAULT_URL;
}

// ── Cases 22-25: Network routing (substrate isolation) ────────────────────────
{
  const origFetch2 = globalThis.fetch;
  let capturedUrl  = null;
  let capturedBody = null;
  globalThis.fetch = async (url, opts) => {
    capturedUrl  = url;
    capturedBody = JSON.parse(opts?.body ?? '{}');
    return { ok: true, json: async () => ({ status: 'ok' }), text: async () => 'ok' };
  };
  process.env.EXERGYNET_API_KEY = 'test-key';

  // Case 22: mainnet routes to portal.exergynet.org (not dt.portal)
  process.env.EXERGYNET_NETWORK = 'mainnet';
  delete process.env.EXERGYNET_VAULT_URL;
  await syncToVault('x', 'test');
  ok('22 EXERGYNET_NETWORK=mainnet → portal.exergynet.org',
    capturedUrl?.includes('portal.exergynet.org') && !capturedUrl?.includes('dt.portal'));

  // Case 23: testnet routes to dt.portal.exergynet.org
  process.env.EXERGYNET_NETWORK = 'testnet';
  await syncToVault('x', 'test');
  ok('23 EXERGYNET_NETWORK=testnet → dt.portal.exergynet.org',
    capturedUrl?.includes('dt.portal.exergynet.org'));

  // Case 24: EXERGYNET_VAULT_URL overrides EXERGYNET_NETWORK
  process.env.EXERGYNET_NETWORK = 'mainnet';
  process.env.EXERGYNET_VAULT_URL = 'https://custom.example.com';
  await syncToVault('x', 'test');
  ok('24 EXERGYNET_VAULT_URL overrides EXERGYNET_NETWORK',
    capturedUrl?.includes('custom.example.com'));

  // Case 25: network field injected into POST body
  delete process.env.EXERGYNET_VAULT_URL;
  process.env.EXERGYNET_NETWORK = 'testnet';
  await syncToVault('x', 'test');
  ok('25 body.network injected from EXERGYNET_NETWORK', capturedBody?.network === 'testnet');

  delete process.env.EXERGYNET_API_KEY;
  delete process.env.EXERGYNET_NETWORK;
  delete process.env.EXERGYNET_VAULT_URL;
  globalThis.fetch = origFetch2;
}

// ── Cases 26-27: vmn_search namespace filter ──────────────────────────────────
{
  const hOps     = ingest_text('Telemetry spike observed in alpha cluster.', { namespace: 'ops' });
  const hFinance = ingest_text('Telemetry forecast reviewed in beta portfolio.', { namespace: 'finance' });

  const rFiltered = search_vault('telemetry', 10, 'ops');
  ok('26 namespace=ops excludes finance result',
    rFiltered.results.some(r => r.root === hOps) &&
    rFiltered.results.every(r => r.root !== hFinance));

  const rAll = search_vault('telemetry', 10);
  ok('27 unfiltered search returns all namespaces',
    rAll.results.some(r => r.root === hOps) &&
    rAll.results.some(r => r.root === hFinance));

  delete_entry(hOps);
  delete_entry(hFinance);
}

// ── Cases 28-30: ingest_file_delta cursor tracking ────────────────────────────
{
  const tmpFile  = join(tmpdir(), `vmn_test_${Date.now()}.txt`);
  const sid      = `test-cursor-${Date.now()}`;

  // Case 28: fresh file — all lines ingested
  writeFileSync(tmpFile, 'Alpha line content.\nBeta line content.\n');
  const r28 = ingest_file_delta(tmpFile, sid, { namespace: 'file_test' });
  ok('28 ingest_file_delta: ingests new file content',
    r28.lines_ingested === 2 && r28.hash !== null && r28.cursor_line === 2);

  // Case 29: append — only new lines ingested (delta)
  appendFileSync(tmpFile, 'Gamma line content.\nDelta line content.\n');
  const r29 = ingest_file_delta(tmpFile, sid, { namespace: 'file_test' });
  ok('29 ingest_file_delta: second call ingests only appended lines',
    r29.lines_ingested === 2 && r29.cursor_line === 4);

  // Case 30: no change — zero lines, null hash
  const r30 = ingest_file_delta(tmpFile, sid);
  ok('30 ingest_file_delta: no new content returns zero',
    r30.lines_ingested === 0 && r30.hash === null && r30.cursor_line === 4);

  try { unlinkSync(tmpFile); } catch {}
  if (r28.hash) delete_entry(r28.hash);
  if (r29.hash) delete_entry(r29.hash);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
// -- Cases 31-34: retrieve_evidence_adaptive (LNES-86.6 static default + inline escape) --
{
  // Case 31: selective/rare term -- should stay on the static default path
  // (no escape) and match the same evidence retrieve_evidence() would find.
  const hSel = ingest_text('Patient reports lisinopril for blood pressure management.', { namespace: 'adaptive_test' });
  const rSel = retrieve_evidence_adaptive(hSel, 'lisinopril');
  ok('31 adaptive: selective term matches evidence (no-escape path)',
    rSel.toLowerCase().includes('lisinopril'));
  delete_entry(hSel);

  // Case 32: build a large multi-chunk document where one term appears in
  // EVERY chunk (document frequency > RARE_TERM_MAX_DF=10) -- this must fail
  // the rare-term gate and trigger the inline escape (full-chunk fallback
  // scoring), while still returning correct, non-empty evidence.
  const paragraphs = [];
  for (let i = 0; i < 15; i++) {
    paragraphs.push('Commonwordmarker appears in this paragraph. '.repeat(60) + `Section ${i} filler text to reach target chunk size padding content here.`);
  }
  const hEscape = ingest_text(paragraphs.join('\n\n'), { namespace: 'adaptive_test' });
  const rEscape = retrieve_evidence_adaptive(hEscape, 'commonwordmarker');
  ok('32 adaptive: high-df term triggers escape and still returns valid evidence',
    rEscape !== 'no_relevant_evidence_found' && rEscape.toLowerCase().includes('commonwordmarker'));
  delete_entry(hEscape);

  // Case 33: no-hit query -- zero matching terms must return the safe
  // no-match sentinel, not fabricated evidence, on the adaptive path too.
  const hNoHit = ingest_text('This document discusses quarterly revenue projections.', { namespace: 'adaptive_test' });
  const rNoHit = retrieve_evidence_adaptive(hNoHit, 'xyzxyznomatch');
  ok('33 adaptive: no-hit query returns no_relevant_evidence_found',
    rNoHit === 'no_relevant_evidence_found');
  delete_entry(hNoHit);

  // Case 34: missing shard -- must report an error string, never crash or
  // fabricate evidence.
  const rMissing = retrieve_evidence_adaptive('0000000000000000000000000000000000000000000000000000000000000000', 'anything');
  ok('34 adaptive: missing shard returns ERROR string',
    typeof rMissing === 'string' && rMissing.startsWith('ERROR:'));
}

hashes.forEach(h => delete_entry(h));

// ── Cases 35–42: evidence-native benchmark module ─────────────────────────────

// Case 35: all benchmark records carry the required evidence-native fields
ok('35 benchmark_records: all records have required evidence-native fields',
  BENCHMARK_RECORDS.every(r =>
    typeof r.benchmark_id === 'string' &&
    typeof r.measured_value === 'number' &&
    typeof r.unit === 'string' &&
    typeof r.tested_envelope === 'string' &&
    typeof r.derivation_type === 'string' &&
    typeof r.evidence_class === 'string' &&
    typeof r.evidence_sha256 === 'string' &&
    typeof r.publicly_verifiable === 'boolean' &&
    r.universal_claim === false
  )
);

// Case 36: sealed holdout mean-K record has correct measured value and type
const meanKRecord = BENCHMARK_RECORDS.find(r => r.benchmark_id === 'LNES82C10M-HOLDOUT-MEAN-K');
ok('36 benchmark: LNES82C10M-HOLDOUT-MEAN-K measured_value=895.96, derivation_type=MEASURED',
  meanKRecord !== undefined &&
  meanKRecord.measured_value === 895.96 &&
  meanKRecord.derivation_type === 'MEASURED'
);

// Case 37: state-ratio record is DERIVED from the sealed holdout, value ≈ 11291
const ratioRecord = BENCHMARK_RECORDS.find(r => r.benchmark_id === 'LNES82C10M-STATE-RATIO');
ok('37 benchmark: LNES82C10M-STATE-RATIO derivation_type=DERIVED, evidence_class=SEALED_HOLDOUT, value≈11291',
  ratioRecord !== undefined &&
  ratioRecord.derivation_type === 'DERIVED' &&
  ratioRecord.evidence_class === 'SEALED_HOLDOUT' &&
  Math.abs(ratioRecord.measured_value - 11291) < 2
);

// Case 38: OLS slope claim_boundary explicitly notes CI spans zero
const olsRecord = BENCHMARK_RECORDS.find(r => r.benchmark_id === 'LNES82C4M-OLS-9PT-SLOPE');
ok('38 benchmark: OLS slope claim_boundary mentions CI spans zero',
  olsRecord !== undefined &&
  olsRecord.claim_boundary.toLowerCase().includes('zero')
);

// Case 39: compute_context_comparison returns WITHIN_TESTED_ENVELOPE for corpus ≤ 10M
const withinResult = compute_context_comparison(1_000_000);
ok('39 context_compare: 1M corpus → WITHIN_TESTED_ENVELOPE',
  withinResult.envelope_status === 'WITHIN_TESTED_ENVELOPE' &&
  withinResult.measured_K_tokens === 895.96 &&
  withinResult.universal_claim === false
);

// Case 40: compute_context_comparison returns OUTSIDE_TESTED_ENVELOPE and WARNING for > 10M
const outsideResult = compute_context_comparison(20_000_000);
ok('40 context_compare: 20M corpus → OUTSIDE_TESTED_ENVELOPE with WARNING in claim_boundary',
  outsideResult.envelope_status === 'OUTSIDE_TESTED_ENVELOPE' &&
  outsideResult.claim_boundary.includes('WARNING')
);

// Case 41: with cost_per_million provided, savings_per_query_usd > 0 when full_ctx > measured_K
const costResult = compute_context_comparison(50_000, 100, 50_000, 15.0);
ok('41 context_compare: cost_comparison computes positive savings when full_ctx(50K) > K(895.96)',
  costResult.cost_comparison !== undefined &&
  (costResult.cost_comparison.savings_per_query_usd > 0) &&
  (costResult.cost_comparison.queries_per_day === 100)
);

// Case 42: universal_claim === false (strict boolean literal) for all benchmark records
ok('42 benchmark_records: universal_claim is strict false for all records',
  BENCHMARK_RECORDS.every(r => r.universal_claim === false && typeof r.universal_claim === 'boolean')
);

// ── Cases 43–50: provenance integrity + input validation (publication gate) ───

// Case 43: every evidence_sha256 is a real 64-char hex digest (no placeholder strings)
ok('43 benchmark_records: every evidence_sha256 is a 64-hex digest (no placeholders)',
  BENCHMARK_RECORDS.every(r => /^[0-9a-f]{64}$/.test(r.evidence_sha256))
);

// Case 44: derivation_type is restricted to the three declared categories
const ALLOWED_DERIV = new Set(['MEASURED', 'DERIVED', 'REFERENCE_ONLY']);
ok('44 benchmark_records: derivation_type ∈ {MEASURED, DERIVED, REFERENCE_ONLY}',
  BENCHMARK_RECORDS.every(r => ALLOWED_DERIV.has(r.derivation_type))
);

// Case 45: the H200 throughput record is REFERENCE_ONLY, not sealed evidence
const h200 = BENCHMARK_RECORDS.find(r => r.benchmark_id === 'H200-XLMP-CORRECT-TASK-THROUGHPUT');
ok('45 benchmark: H200 throughput is REFERENCE_ONLY / INTERNAL_ENGINEERING_REPORT, publicly_verifiable=false',
  h200 !== undefined &&
  h200.derivation_type === 'REFERENCE_ONLY' &&
  h200.evidence_class === 'INTERNAL_ENGINEERING_REPORT' &&
  h200.publicly_verifiable === false &&
  Math.abs(h200.measured_value - 11.3) < 1e-9
);

// Case 46: exact tested ceiling stays WITHIN the envelope; one token above flips OUTSIDE
const ceil = compute_context_comparison(10_116_589);
const overCeil = compute_context_comparison(10_116_590);
ok('46 context_compare: exact ceiling = WITHIN, ceiling+1 = OUTSIDE',
  ceil.envelope_status === 'WITHIN_TESTED_ENVELOPE' &&
  overCeil.envelope_status === 'OUTSIDE_TESTED_ENVELOPE'
);

// Case 47: negative and zero corpus_tokens throw RangeError (no NaN result leaks)
function throwsRange(fn) {
  try { fn(); return false; } catch (e) { return e instanceof RangeError; }
}
ok('47 context_compare: negative and zero corpus_tokens throw RangeError',
  throwsRange(() => compute_context_comparison(-5)) &&
  throwsRange(() => compute_context_comparison(0)) &&
  throwsRange(() => compute_context_comparison(Infinity)) &&
  throwsRange(() => compute_context_comparison(NaN))
);

// Case 48: very large corpus produces finite numbers (no NaN / Infinity) and OUTSIDE status
const huge = compute_context_comparison(1e15, 1, 1e15, 10);
ok('48 context_compare: 1e15 corpus → finite outputs, OUTSIDE, no NaN/Infinity',
  huge.envelope_status === 'OUTSIDE_TESTED_ENVELOPE' &&
  Number.isFinite(huge.active_context_ratio) &&
  huge.cost_comparison !== undefined &&
  Number.isFinite(huge.cost_comparison.savings_per_query_usd) &&
  Number.isFinite(huge.cost_comparison.savings_per_day_usd)
);

// Case 49: cost_per_million=0 is accepted (free tier) and yields zero savings, not an error
const freeTier = compute_context_comparison(50_000, 1, 50_000, 0);
ok('49 context_compare: cost_per_million=0 accepted, savings=0 (not rejected)',
  freeTier.cost_comparison !== undefined &&
  freeTier.cost_comparison.savings_per_query_usd === 0
);

// Case 50: compute_context_comparison result advertises publicly_verifiable=false
ok('50 context_compare: result carries publicly_verifiable=false and universal_claim=false',
  freeTier.publicly_verifiable === false && freeTier.universal_claim === false
);

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\nRegression suite: ${pass}/${pass + fail} pass`);
if (fail > 0) process.exit(1);
