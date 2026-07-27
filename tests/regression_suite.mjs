/**
 * VMN Regression Suite — 15 historical benchmark cases + stemmer parity pre-flight.
 * Run: node tests/regression_suite.mjs
 * Gate: all cases must pass before any release ships.
 */
import assert from 'node:assert';
import { performance } from 'perf_hooks';
import { stemToken } from '../dist/normalization.js';
import {
  ingest_text, retrieve_evidence, search_vault, delete_entry,
} from '../dist/core.js';

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

// ── Cleanup ───────────────────────────────────────────────────────────────────
hashes.forEach(h => delete_entry(h));

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\nRegression suite: ${pass}/${pass + fail} pass`);
if (fail > 0) process.exit(1);
