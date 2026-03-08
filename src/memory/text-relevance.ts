/**
 * CJK-aware text relevance computation.
 * Handles Chinese/Japanese/Korean text by extracting unigrams + bigrams,
 * and ASCII text by whitespace splitting.
 */

// Unicode ranges for CJK characters
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2ebef}]/u;

/**
 * Tokenize text for relevance matching.
 * - ASCII words: split by whitespace, lowercased, length > 1
 * - CJK: extract individual characters (unigrams) + consecutive bigrams
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  // Extract ASCII words
  const asciiWords = lower.match(/[a-z0-9_\-]+/g);
  if (asciiWords) {
    for (const w of asciiWords) {
      if (w.length > 1) tokens.push(w);
    }
  }

  // Extract CJK unigrams + bigrams
  const cjkChars: string[] = [];
  for (const ch of lower) {
    if (CJK_REGEX.test(ch)) {
      cjkChars.push(ch);
    }
  }

  // Unigrams
  for (const ch of cjkChars) {
    tokens.push(ch);
  }

  // Bigrams from consecutive CJK runs
  const cjkRuns: string[] = [];
  let run = '';
  for (const ch of lower) {
    if (CJK_REGEX.test(ch)) {
      run += ch;
    } else {
      if (run.length >= 2) cjkRuns.push(run);
      run = '';
    }
  }
  if (run.length >= 2) cjkRuns.push(run);

  for (const r of cjkRuns) {
    const chars = [...r];
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.push(chars[i]! + chars[i + 1]!);
    }
  }

  return tokens;
}

/**
 * Compute relevance score between a query and a document.
 * Returns 0-1 where 1 means perfect match.
 *
 * Algorithm:
 * 1. Tokenize both query and document
 * 2. Count overlapping tokens (weighted by uniqueness in query)
 * 3. Bonus for substring containment of original query
 */
export function computeRelevance(query: string, document: string): number {
  if (!query || !document) return 0;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const docTokens = new Set(tokenize(document));
  if (docTokens.size === 0) return 0;

  // Count unique query tokens that appear in document
  const uniqueQueryTokens = [...new Set(queryTokens)];
  let matchCount = 0;
  for (const qt of uniqueQueryTokens) {
    if (docTokens.has(qt)) {
      matchCount++;
    }
  }

  // Base score: proportion of query tokens found in document
  const tokenScore = matchCount / uniqueQueryTokens.length;

  // Substring bonus: if query (trimmed, lowered) appears literally in document
  const queryLower = query.trim().toLowerCase();
  const docLower = document.toLowerCase();
  const substringBonus = docLower.includes(queryLower) ? 0.2 : 0;

  return Math.min(tokenScore + substringBonus, 1);
}
