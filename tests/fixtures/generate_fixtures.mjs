import { createHash } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';

const DOMAINS = [
  { domain: 'clinical', templates: [
    'Patient {N} presents with {SYMPTOM}. PMH includes {CONDITION}. Currently taking {MED}.',
    'Vital signs: BP {BP}, HR {HR}. Assessment: {CONDITION}. Plan: {PLAN}.',
    'Lab results show {LAB}. Physician {DOC} recommends {PLAN}.',
    'The patient has a smoking history and tobacco use disorder. High blood pressure noted.',
    'Hypertension managed with ACE inhibitor. Primary care physician follow-up scheduled.',
  ]},
  { domain: 'legal', templates: [
    'Section {N}: The party of the first part agrees to {ACTION} per the agreement dated {DATE}.',
    'Whereas the contractor shall deliver {ITEM} no later than {DATE}, failure constitutes breach.',
    'Arbitration clause: disputes arising under this agreement shall be resolved by {ARBITER}.',
  ]},
  { domain: 'software', templates: [
    'v{N}.0.0: Fixed THROTTLE_BURST_OVERRIDE flag behavior in rate limiter module.',
    'CHANGELOG: Deprecated {API}. Migration: replace with {NEWAPI} by {DATE}.',
    'Bug #{N}: Memory leak in {MODULE} when {CONDITION}. Fixed in commit {HASH}.',
  ]},
  { domain: 'meeting', templates: [
    'Q{N} review: revenue {REV}. Action items: {ACTION1}, {ACTION2}.',
    'Meeting notes {DATE}: {PERSON1} to complete {TASK} by {DATE2}. {PERSON2} flagged {ISSUE}.',
  ]},
];

const WORDS = {
  SYMPTOM: ['chest pain','fatigue','headache','nausea','shortness of breath'],
  CONDITION: ['hypertension','diabetes','COPD','atrial fibrillation','hypothyroidism'],
  MED: ['metformin','lisinopril','atorvastatin','amlodipine','levothyroxine'],
  BP: ['120/80','140/90','135/85','118/76','150/95'],
  HR: ['72','88','64','95','78'],
  LAB: ['elevated HbA1c 8.2','normal CBC','low TSH 0.3','high LDL 190','normal BMP'],
  DOC: ['Smith','Patel','Chen','Williams','Garcia'],
  PLAN: ['lifestyle modification','medication adjustment','specialist referral','follow-up in 3 months'],
  N: ['1','2','3','4','5','7','12','42','100','227'],
  DATE: ['2026-01-15','2026-03-01','2026-06-30','2026-09-01','2026-12-31'],
  DATE2: ['next Friday','end of quarter','before launch','by EOD'],
  ACTION: ['deliver services','provide support','maintain confidentiality','pay invoices'],
  ITEM: ['software deliverable','hardware component','documentation package'],
  ARBITER: ['JAMS','AAA','ICC','a mutually agreed panel'],
  API: ['getUser()','fetchRecord()','postData()','deleteItem()'],
  NEWAPI: ['users.get()','records.fetch()','data.post()','items.delete()'],
  MODULE: ['cache manager','session handler','file processor','queue worker'],
  HASH: ['a3f8c29','7b1d4e6','c92a0f3','5e8d1b7'],
  REV: ['+12% YoY','on target','$2.3M','below forecast by 8%'],
  ACTION1: ['complete audit','review proposals','finalize budget'],
  ACTION2: ['schedule training','update documentation','notify stakeholders'],
  PERSON1: ['Alice','Bob','Carol','David','Eve'],
  PERSON2: ['Frank','Grace','Hank','Iris','Jack'],
  TASK: ['the security review','Q4 planning','vendor evaluation','code freeze'],
  ISSUE: ['timeline risk','resource constraint','scope creep','technical debt'],
};

function makeDoc(seed, size) {
  const lines = [];
  const domain = DOMAINS[seed % DOMAINS.length];
  const template = domain.templates[seed % domain.templates.length];
  let rng = seed;
  const filled = template.replace(/\{(\w+)\}/g, (_, k) => {
    const opts = WORDS[k] || [k];
    rng = (rng * 1664525 + 1013904223) & 0xffffffff;
    return opts[Math.abs(rng) % opts.length];
  });
  while (lines.join('\n').length < size) {
    lines.push(filled + ` [ref:${seed}-${lines.length}]`);
  }
  return lines.join('\n');
}

const SIZES = [10, 100, 669, 1000, 10000];
for (const count of SIZES) {
  const dir = `tests/fixtures/vault-${count}`;
  mkdirSync(dir, { recursive: true });
  const docs = [];
  for (let i = 0; i < count; i++) {
    const text = makeDoc(i * 17, 500 + (i % 5) * 200);
    const root = createHash('sha256').update(text).digest('hex');
    docs.push({ index: i, root, text,
      title: `Doc ${i} [${['clinical','legal','software','meeting'][i % 4]}]`,
      domain: ['clinical','legal','software','meeting'][i % 4]
    });
  }
  writeFileSync(`${dir}/documents.json`, JSON.stringify(docs, null, 2));
  const deepDoc = 'Introduction and preamble. '.repeat(10) +
    'The THROTTLE_BURST_OVERRIDE configuration flag prevents sustained rate limit violations. ' +
    'It must be set to false in production environments.';
  writeFileSync(`${dir}/deep_body_fixture.txt`, deepDoc);
  writeFileSync(`${dir}/meta.json`, JSON.stringify({
    count, generated_at: new Date().toISOString(),
    deep_body_term: 'THROTTLE_BURST_OVERRIDE',
    deep_body_offset: deepDoc.indexOf('THROTTLE_BURST_OVERRIDE')
  }));
  console.log(`Generated vault-${count}: ${docs.length} docs`);
}
