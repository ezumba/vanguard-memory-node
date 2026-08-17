/**
 * LNES-86.6 -- Compact Index candidate discovery, query-scoped variant.
 * Real, measured basis (LNES86_ADAPTIVE_ROUTING_TS_R6.md, EDT internal):
 * 100% decision parity with a full-document-index-build baseline over the
 * frozen LNES-86 benchmark population, ~1.56x median speedup on the
 * pre-scoring stage for fall-back cases. Tracks postings ONLY for the
 * query's own term prefixes -- not every distinct word in the document --
 * avoiding Map/Set housekeeping for irrelevant words while still requiring
 * one tokenization pass per chunk (unavoidable: some scan is required to
 * know whether a query prefix occurs at all).
 */

export const PREFIX_LEN = 4;
export const RARE_TERM_MAX_DF = 10;

export interface CandidateResult {
  candidateIndices: number[];
  status: 'NO_MATCHING_MEMORY' | 'CANDIDATES_FOUND';
}

function tokenizeWords(text: string): string[] {
  const matches = text.match(/[a-z0-9]+/g);
  return matches || [];
}

/**
 * Query-scoped candidate discovery: a single fused pass over chunks that
 * tracks postings only for the query's own prefixes. Same candidate-
 * selection semantics as a full posting-index build (same PREFIX_LEN /
 * RARE_TERM_MAX_DF rare-term gate), cheaper because it never materializes
 * postings for words the query doesn't care about.
 */
export function queryScopedCandidates(chunks: string[], queryTerms: string[]): CandidateResult {
  if (queryTerms.length === 0) {
    return { candidateIndices: [], status: 'NO_MATCHING_MEMORY' };
  }

  const prefixes = new Set(queryTerms.map(t => t.slice(0, PREFIX_LEN)));
  const postingForPrefix = new Map<string, Set<number>>(
    [...prefixes].map(p => [p, new Set<number>()])
  );

  for (let i = 0; i < chunks.length; i++) {
    const words = tokenizeWords(chunks[i].toLowerCase());
    for (const w of words) {
      const key = w.slice(0, PREFIX_LEN);
      const set = postingForPrefix.get(key);
      if (set) set.add(i);
    }
  }

  const wordDf = new Map<string, number>();
  for (const qw of queryTerms) {
    wordDf.set(qw, postingForPrefix.get(qw.slice(0, PREFIX_LEN))!.size);
  }

  const rareWords = queryTerms.filter(qw => {
    const df = wordDf.get(qw)!;
    return df > 0 && df <= RARE_TERM_MAX_DF;
  });
  if (rareWords.length === 0) {
    return { candidateIndices: [], status: 'NO_MATCHING_MEMORY' };
  }

  const candidateSet = new Set<number>();
  for (const qw of queryTerms) {
    for (const idx of postingForPrefix.get(qw.slice(0, PREFIX_LEN))!) candidateSet.add(idx);
  }

  return {
    candidateIndices: [...candidateSet],
    status: candidateSet.size > 0 ? 'CANDIDATES_FOUND' : 'NO_MATCHING_MEMORY',
  };
}
