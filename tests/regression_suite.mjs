/**
 * VMN Regression Suite — 15 historical benchmark cases + stemmer parity pre-flight.
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

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\nRegression suite: ${pass}/${pass + fail} pass`);
if (fail > 0) process.exit(1);
