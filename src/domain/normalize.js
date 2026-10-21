/**
 * Matching normalisation. Used ONLY for comparing text; the original transcript and documents are never modified.
 * Lowercase, strip punctuation, drop apostrophes ("don't" -> "dont"), split on whitespace/hyphens/dashes/slashes.
 * Digits are kept as-is (no number-to-words expansion): "26" will not match "twenty six" exactly.
 */
export function normalizeToken(raw) {
  return raw.normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019\u02bc`\u00b4']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
/** Spoken fillers that a verbatim transcript keeps but a written document usually lacks. Ignored for matching only (on both sides). */
export const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mhm', 'mmhmm']);
const SPLIT = /[\s\u2014\u2013\u2012\-/]+/u;
export function tokenizeText(text) {
  const out = [];
  for (const part of String(text).split(SPLIT)) {
    const n = normalizeToken(part);
    if (n && !FILLERS.has(n)) out.push(n);
  }
  return out;
}
/** Maps normalised tokens back to transcript word indexes, so a token match can read word timestamps. */
export function tokenizeTranscript(words) {
  const norms = [], wordIndex = [], firstTokenOfWord = new Map(), lastTokenOfWord = new Map();
  for (const w of words) {
    for (const t of tokenizeText(w.word)) {
      if (!firstTokenOfWord.has(w.index)) firstTokenOfWord.set(w.index, norms.length);
      lastTokenOfWord.set(w.index, norms.length);
      norms.push(t);
      wordIndex.push(w.index);
    }
  }
  return { norms, wordIndex, firstTokenOfWord, lastTokenOfWord };
}
