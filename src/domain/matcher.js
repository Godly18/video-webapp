/**
 * Word-sequence matching against the master transcript tokens. Never guesses between equally good candidates.
 * Order of attack: (1) exact word sequence, extended with context until unique; (2) approximate alignment that tolerates
 * a few wrong/missing/extra words and near-spellings; (3) low-confidence candidates the USER must confirm; (4) unmatched + closest passage.
 */
export function findExact(norms, seq, from, to) {
  const out = [], n = seq.length;
  for (let i = Math.max(0, from); i + n <= Math.min(to, norms.length); i++) {
    let ok = true;
    for (let j = 0; j < n; j++) if (norms[i + j] !== seq[j]) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function lev(a, b) {
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
/** 0 for equal words, partial cost for near-spellings (look/looked), 1 for different words. */
export function tokenCost(a, b) {
  if (a === b) return 0;
  const m = Math.max(a.length, b.length);
  if (m <= 3) return 1;
  const r = lev(a, b) / m;
  return r <= 0.34 ? r : 1;
}
/** Semi-global alignment of seq against norms[from,to): free start/end in the text, the last seq token must be aligned to a real token. */
function alignTail(norms, seq, from, to) {
  const text = norms.slice(Math.max(0, from), Math.min(to, norms.length)), m = text.length, k = seq.length, base = Math.max(0, from);
  if (!m || !k) return [];
  let prevD = new Array(m + 1).fill(0), prevS = Array.from({ length: m + 1 }, (_, j) => j);
  let ends = [];
  for (let i = 1; i <= k; i++) {
    const curD = [i], curS = [0];
    if (i === k) ends = [];
    for (let j = 1; j <= m; j++) {
      const diag = prevD[j - 1] + tokenCost(seq[i - 1], text[j - 1]), del = prevD[j] + 1, ins = curD[j - 1] + 1;
      if (i === k) ends.push({ cost: diag, startToken: base + prevS[j - 1], endToken: base + j - 1 });
      if (diag <= del && diag <= ins) { curD[j] = diag; curS[j] = prevS[j - 1]; }
      else if (del <= ins) { curD[j] = del; curS[j] = prevS[j]; }
      else { curD[j] = ins; curS[j] = curS[j - 1]; }
    }
    prevD = curD; prevS = curS;
  }
  return ends;
}
function alignAnchor(norms, seq, from, to, anchor) {
  if (anchor === 'tail') return alignTail(norms, seq, from, to);
  const lo = Math.max(0, from), hi = Math.min(to, norms.length), L = hi - lo;
  if (L <= 0) return [];
  const rev = norms.slice(lo, hi).reverse();
  return alignTail(rev, seq.slice().reverse(), 0, L).map((c) => ({ cost: c.cost, startToken: lo + (L - 1 - c.endToken), endToken: lo + (L - 1 - c.startToken) }));
}
function bestNonOverlapping(list) {
  const sorted = list.slice().sort((a, b) => a.cost - b.cost || a.startToken - b.startToken), kept = [];
  for (const c of sorted) if (!kept.some((x) => c.startToken <= x.endToken && x.startToken <= c.endToken)) kept.push(c);
  return kept;
}

/**
 * anchor 'tail': seq is the end of a batch; the relevant token is the LAST token of the match.
 * anchor 'head': seq is the words after an image marker; the relevant token is the FIRST token of the match.
 * Returns {status: matched|ambiguous|unmatched, method: exact|fuzzy|fuzzy_low|none, candidates:[{tokenIndex,startToken,endToken,score}], closest?}.
 * fuzzy_low = nothing matched well; candidates are the best guesses and the user must confirm one.
 */
export function resolveSequence(norms, seq, { from, to, anchor, minLen = 6, maxLen = 60, fuzzyThreshold = 0.85, reviewThreshold = 0.45, fuzzyLen = 16 }) {
  const n = seq.length;
  if (n === 0) return { status: 'unmatched', method: 'none', reason: 'EMPTY_SEQUENCE', candidates: [] };
  const slice = (k) => (anchor === 'tail' ? seq.slice(n - k) : seq.slice(0, k));
  const mk = (startToken, endToken, score) => ({ startToken, endToken, tokenIndex: anchor === 'tail' ? endToken : startToken, score });
  let last = null;
  for (let k = Math.min(n, minLen); k <= Math.min(n, maxLen); k++) {
    const pos = findExact(norms, slice(k), from, to);
    if (pos.length === 0) break;
    last = { k, pos };
    if (pos.length === 1) return { status: 'matched', method: 'exact', phraseLength: k, candidates: [mk(pos[0], pos[0] + k - 1, 1)] };
  }
  if (last) return { status: 'ambiguous', method: 'exact', phraseLength: last.k, candidates: last.pos.map((p) => mk(p, p + last.k - 1, 1)) };

  const k = Math.min(n, fuzzyLen), phrase = slice(k);
  const cands = bestNonOverlapping(alignAnchor(norms, phrase, from, to, anchor)).map((c) => mk(c.startToken, c.endToken, Math.max(0, 1 - c.cost / k)));
  const best = cands[0];
  if (!best) return { status: 'unmatched', method: 'fuzzy', reason: 'NO_TEXT_IN_RANGE', phraseLength: k, candidates: [] };
  if (best.score >= fuzzyThreshold) {
    const close = cands.filter((c) => c.score >= best.score - 0.05);
    return { status: close.length === 1 ? 'matched' : 'ambiguous', method: 'fuzzy', phraseLength: k, candidates: close };
  }
  const review = cands.filter((c) => c.score >= reviewThreshold).slice(0, 3);
  if (review.length) return { status: 'ambiguous', method: 'fuzzy_low', phraseLength: k, candidates: review };
  return { status: 'unmatched', method: 'fuzzy', reason: 'NO_MATCH', phraseLength: k, candidates: [], closest: best };
}
