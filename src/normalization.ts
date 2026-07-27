/**
 * normalization.ts — VMN v1.2.0
 * Single normalization pipeline shared by ingest, search, recall, rebuild, delete.
 * Both vmn_search and vmn_recall MUST import from this module.
 */
export const NORMALIZATION_VERSION  = '1.2.0';
export const STEMMER_VERSION        = '1.3.3';
export const ALIAS_DICT_VERSION     = '1.2.1';

// ── Stop words ────────────────────────────────────────────────────────────────
export const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','is','was','are','were','be','been','has','have','had',
  'do','does','did','will','would','could','should','may','might','shall',
  'not','no','nor','so','yet','both','either','neither','whether',
  'that','this','these','those','which','who','whom','whose','what','when',
  'where','why','how','all','each','every','both','few','more','most',
  'other','some','such','than','too','very','just','also','only','own',
  'same','than','then','there','here','i','you','he','she','we','they',
  'it','its','my','your','his','her','our','their','me','him','us','them',
]);

// ── Multi-word phrase aliases (processed BEFORE tokenization) ─────────────────
export const PHRASE_ALIASES: Array<[string, string]> = [
  // Clinical — multi-word first
  ['high blood pressure',          'hypertension'],
  ['blood pressure',               'bp'],
  ['tobacco use disorder',         'smoking'],
  ['tobacco use',                  'smoking'],
  ['smoking history',              'smoking'],
  ['primary care physician',       'doctor'],
  ['general practitioner',         'doctor'],
  ['myocardial infarction',        'heartattack'],
  ['heart attack',                 'heartattack'],
  ['type 2 diabetes',              'diabetes'],
  ['type 1 diabetes',              'diabetes'],
  ['blood sugar',                  'glucose'],
  // Legal
  ['breach of contract',           'breach'],
  ['party of the first part',      'firstparty'],
  // Clinical — additional
  ['shortness of breath',          'dyspnea'],
  ['chest pain',                   'cardiacpain'],
  ['cardiac pain',                 'cardiacpain'],
  ['blood glucose',                'glucose'],
  // Legal
  ['force majeure',                'forcemajeure'],
  ['intellectual property',        'ip'],
  // Technical
  ['rate limit',                   'ratelimit'],
  ['rate limiting',                'ratelimit'],
  ['memory leak',                  'memoryleak'],
  ['out of memory',                'oom'],
  ['null pointer',                 'nullref'],
  ['stack overflow',               'stackoverflow'],
  // Medical providers
  ['attending physician',          'doctor'],
  ['primary care',                 'doctor'],
];

// ── Single-token aliases (processed AFTER tokenization and stemming) ──────────
export const TOKEN_ALIASES: Record<string, string[]> = {
  // smoke cluster
  'smok':        ['tobacco'],
  'smoke':        ['smok', 'tobacco'],
  'tobacco':     ['smok'],
  'cigarett':    ['smok', 'tobacco'],
  'nicotine':    ['smok'],
  // medical
  'physician':   ['doctor'],
  'doctor':      ['physician'],
  'dr':          ['doctor', 'physician'],
  'hypertens':   ['bp'],
  'bp':          ['hypertens'],
  'glucose':     ['bloodsugar', 'bgl'],
  'heartattack': ['mi', 'myocardi'],
  'dyspnea':     ['sob', 'breathless'],
  // technical
  'ratelimit':   ['throttl', 'burst'],
  'throttl':     ['ratelimit'],
  // Note: 'generic' has NO aliases — false positive guard preserved
};

// ── Suffix stemmer ────────────────────────────────────────────────────────────
export function stemToken(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 6 && w.endsWith('ings'))  return w.slice(0, -4);
  if (w.length > 6 && w.endsWith('ing'))   return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ers'))   return w.slice(0, -3);
  if (w.length > 6 && w.endsWith('tions')) return w.slice(0, -5);  // medications→medica (matches medication→medica)
  if (w.length > 5 && w.endsWith('ions'))  return w.slice(0, -4);
  if (w.length > 5 && w.endsWith('tion'))  return w.slice(0, -4);
  if (w.length > 8 && w.endsWith('sion'))  return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ies'))   return w.slice(0, -3);  // allergies→allerg
  if (w.length > 6 && w.endsWith('ic'))    return w.slice(0, -2);  // allergic→allerg
  if (w.length > 4 && w.endsWith('er'))    return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed'))    return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es'))    return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s'))     return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('y'))     return w.slice(0, -1);  // allergy→allerg
  return w;
}

// ── Token alias expansion ─────────────────────────────────────────────────────
export function expandTokenAliases(stemmed: string): string[] {
  const result = new Set<string>([stemmed]);
  const aliases = TOKEN_ALIASES[stemmed] || [];
  for (const alias of aliases) {
    result.add(alias);
  }
  return [...result];
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/** Step 1: Unicode NFC normalization */
export function normalizeUnicode(text: string): string {
  return text.normalize('NFC');
}

/** Step 2: Apply phrase aliases (before tokenization) */
export function normalizePhrases(text: string): string {
  let lower = text.toLowerCase();
  const sorted = [...PHRASE_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, canonical] of sorted) {
    lower = lower.split(phrase).join(` ${canonical} `);
  }
  return lower;
}

/** Step 3: Tokenize */
export function tokenize(text: string): string[] {
  return text
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(w => w.length >= 2);
}

/** Full document normalization pipeline (ingest and recall) */
export function normalizeDocument(text: string): string[] {
  const u = normalizeUnicode(text);
  const p = normalizePhrases(u);
  const tokens = tokenize(p);
  const result = new Set<string>();
  for (const token of tokens) {
    const stemmed = stemToken(token);
    if (stemmed.length < 2 || STOP_WORDS.has(stemmed)) continue;
    result.add(stemmed);
    for (const alias of expandTokenAliases(stemmed)) {
      result.add(alias);
    }
  }
  return [...result];
}

/** Full query normalization pipeline (search and recall query) */
export function normalizeQuery(query: string): string[] {
  return normalizeDocument(query);
}

/** Compute term frequencies for a text block */
export function computeTermFrequencies(text: string): Record<string, number> {
  const u = normalizeUnicode(text);
  const p = normalizePhrases(u);
  const tokens = tokenize(p);
  const freq: Record<string, number> = {};
  for (const token of tokens) {
    const stemmed = stemToken(token);
    if (stemmed.length < 2 || STOP_WORDS.has(stemmed)) continue;
    freq[stemmed] = (freq[stemmed] || 0) + 1;
    for (const alias of expandTokenAliases(stemmed)) {
      freq[alias] = (freq[alias] || 0) + 0.5;
    }
  }
  return freq;
}
