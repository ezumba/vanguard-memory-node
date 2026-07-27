import { normalizeQuery, normalizeDocument } from '../dist/normalization.js';

const PARITY_CASES = [
  // [query, document_text, should_match]
  ['smoke',               'The patient has a tobacco use disorder.',        true],
  ['tobacco',             'The patient smokes cigarettes.',                 true],
  ['smoking',             'Tobacco use noted in patient history.',          true],
  ['doctor',              'Attending physician reviewed the case.',         true],
  ['physician',           'Doctor Smith prescribed medication.',            true],
  ['high blood pressure', 'Hypertension diagnosed at last visit.',          true],
  ['hypertension',        'Patient has high blood pressure.',               true],
  ['shortness of breath', 'Patient presents with dyspnea.',                true],
  ['chest pain',          'Cardiac pain noted on presentation.',            true],
  ['heart attack',        'Myocardial infarction confirmed by ECG.',        true],
  ['blood sugar',         'Glucose level was elevated at 180.',             true],
  ['rate limit',          'The throttle burst override was triggered.',     true],
  ['out of memory',       'Process terminated due to OOM condition.',       true],
  ['breach of contract',  'The party committed a clear breach.',            true],
  // false positive guards
  ['generic',             'The power generator is running.',                false],
  ['all',                 'The patient has allergic reactions.',            false],
  ['section',             'The secretary drafted the memo.',                false],
  ['really',              'This is the real issue here.',                   false],
  ['mission',             'The patient missed their appointment.',          false],
];

let pass = 0, fail = 0;
for (const [q, doc, shouldMatch] of PARITY_CASES) {
  const qTerms = normalizeQuery(q);
  const dTerms = normalizeDocument(doc);
  const matches = qTerms.some(t => dTerms.includes(t));
  const ok = matches === shouldMatch;
  const label = shouldMatch ? 'should match' : 'should NOT match';
  console.log(ok ? 'PASS' : 'FAIL', `"${q}" → "${doc.slice(0, 45)}..." | ${label}`);
  if (ok) pass++; else { fail++; console.log('       qTerms:', qTerms.join(',')); console.log('       dTerms:', dTerms.join(',')); }
}
console.log(`\nAlias coverage: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
