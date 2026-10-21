import { tokenizeTranscript } from './normalize.js';
import { parseBatchText } from './markers.js';
import { resolveSequence } from './matcher.js';

const EPS = 0.01;
/** Word timestamps must be real, ordered and inside the audio. We never invent or spread timings. */
export function validateWords(words, durationSeconds, tolerance = 1.0) {
  const errors = [];
  if (!Array.isArray(words) || words.length === 0) return [{ code: 'NO_WORDS', message: 'The transcript contains no timestamped words.' }];
  let prevStart = 0;
  for (const w of words) {
    const ok = Number.isFinite(w.startSeconds) && Number.isFinite(w.endSeconds) && w.startSeconds >= 0 && w.endSeconds >= w.startSeconds;
    if (!ok) { errors.push({ code: 'INVALID_WORD_TIMESTAMP', wordIndex: w.index, message: `Word ${w.index} ("${w.word}") has missing or invalid timestamps.` }); continue; }
    if (w.startSeconds + EPS < prevStart) errors.push({ code: 'WORDS_OUT_OF_ORDER', wordIndex: w.index, message: `Word ${w.index} starts before the previous word.` });
    if (durationSeconds && w.endSeconds > durationSeconds + tolerance) errors.push({ code: 'WORD_BEYOND_AUDIO', wordIndex: w.index, message: `Word ${w.index} ends after the audio duration.` });
    prevStart = w.startSeconds;
    if (errors.length >= 20) break;
  }
  return errors;
}

const describe = (words, c, T) => {
  const wi = T.wordIndex[c.tokenIndex];
  return { wordIndex: wi, startSeconds: words[wi].startSeconds, endSeconds: words[wi].endSeconds, score: c.score, context: ctxText(words, T.wordIndex[c.startToken] - 3, T.wordIndex[c.endToken] + 3) };
};
const ctxText = (words, a, b) => words.slice(Math.max(0, a), b + 1).map((w) => w.word).join(' ');

/**
 * Pure synchronisation. Inputs: transcript words, authoritative duration, ordered batches [{number, text}], overrides.
 * Batch end  = END timestamp of the final word of the matched ending phrase.
 * Image start = START timestamp of the first word after the marker.
 * Image end  = start of the next image in playback order; final image ends at the authoritative duration.
 * Ambiguous / unmatched items are reported (with candidates) and block rendering; they are never guessed.
 * overrides: { batch_<n>: {wordIndex}, image_<batch>_<marker>: {wordIndex} } (user-confirmed choices, persisted).
 */
export function computeSync({ words, durationSeconds, batches, overrides = {}, minIntervalSeconds = 1 / 30 }) {
  const result = { renderable: false, durationSeconds, batches: [], images: [], warnings: [], errors: [], unresolved: [] };
  const wordErrors = validateWords(words, durationSeconds);
  if (wordErrors.length) { result.errors.push(...wordErrors); return result; }
  const T = tokenizeTranscript(words);
  const lastEnd = words[words.length - 1].endSeconds;
  result.diagnostics = { wordCount: words.length, transcriptEndSeconds: lastEnd, durationSeconds, tailGapSeconds: Math.max(0, durationSeconds - lastEnd) };
  if (durationSeconds - lastEnd > 10) result.warnings.push({ code: 'TRANSCRIPT_ENDS_EARLY', message: `The transcript's last word ends at ${lastEnd.toFixed(1)}s but the audio runs to ${durationSeconds.toFixed(1)}s. The transcription may be incomplete (or the audio ends with silence/music).` });
  const N = T.norms.length;
  let prevEndToken = -1, prevEndSeconds = 0, blocked = false;
  const allImages = [];

  for (const b of batches) {
    const parsed = parseBatchText(b.text);
    const entry = { number: b.number, status: 'blocked', endPhrase: parsed.tokens.slice(-8).join(' '), endSeconds: null, method: null, candidates: [] };
    result.batches.push(entry);
    if (parsed.tokens.length === 0) { entry.status = 'unmatched'; result.errors.push({ code: 'EMPTY_BATCH', batch: b.number, message: `Batch ${b.number} has no spoken words.` }); blocked = true; continue; }
    if (parsed.problems.length) { for (const p of parsed.problems) result.errors.push({ ...p, batch: b.number }); }
    if (blocked) { entry.status = 'blocked'; continue; }

    // --- batch end ---
    let endToken = null;
    const ov = overrides[`batch_${b.number}`];
    if (ov && Number.isInteger(ov.wordIndex) && T.lastTokenOfWord.has(ov.wordIndex) && T.lastTokenOfWord.get(ov.wordIndex) > prevEndToken) {
      endToken = T.lastTokenOfWord.get(ov.wordIndex); entry.status = 'confirmed'; entry.method = 'manual';
    } else {
      const r = resolveSequence(T.norms, parsed.tokens, { from: prevEndToken + 1, to: N, anchor: 'tail' });
      entry.method = r.method;
      entry.candidates = r.candidates.map((c) => describe(words, c, T));
      if (r.closest) entry.closest = describe(words, r.closest, T);
      if (r.status === 'matched') { endToken = r.candidates[0].tokenIndex; entry.status = r.method === 'fuzzy' ? 'matched_fuzzy' : 'matched'; entry.score = r.candidates[0].score; }
      else { entry.status = r.status; result.unresolved.push({ kind: 'batch', id: b.number, status: r.status, method: r.method, candidates: entry.candidates, closest: entry.closest || null }); }
    }
    if (endToken === null) { blocked = true; continue; }
    const endWord = T.wordIndex[endToken];
    entry.endWordIndex = endWord;
    entry.endSeconds = words[endWord].endSeconds;
    if (entry.endSeconds <= prevEndSeconds) result.errors.push({ code: 'BATCH_ORDER_VIOLATION', batch: b.number, message: `Batch ${b.number} ends at ${entry.endSeconds.toFixed(2)}s, not after the previous batch (${prevEndSeconds.toFixed(2)}s). Check the batch order.` });
    if (entry.status === 'matched_fuzzy') result.warnings.push({ code: 'FUZZY_BATCH_END', batch: b.number, message: `Batch ${b.number} ending was matched approximately (score ${entry.score.toFixed(2)}). Please review.` });

    // --- images in this batch ---
    let prevImgToken = prevEndToken;
    for (const mk of parsed.markers) {
      if (mk.followingCount === 0) continue; // already reported as MARKER_NO_SPOKEN_WORDS
      const id = `${b.number}_${mk.number}`;
      const img = { tag: id, batch: b.number, marker: mk.number, status: 'blocked', startSeconds: null, preview: parsed.tokens.slice(mk.tokenIndex, mk.tokenIndex + 8).join(' '), candidates: [] };
      allImages.push(img);
      const following = parsed.tokens.slice(mk.tokenIndex, mk.tokenIndex + mk.followingCount);
      const iov = overrides[`image_${id}`];
      let startToken = null;
      if (iov && Number.isInteger(iov.wordIndex) && T.firstTokenOfWord.has(iov.wordIndex) && T.firstTokenOfWord.get(iov.wordIndex) > prevImgToken && T.firstTokenOfWord.get(iov.wordIndex) <= endToken) {
        startToken = T.firstTokenOfWord.get(iov.wordIndex); img.status = 'confirmed'; img.method = 'manual';
      } else {
        const r = resolveSequence(T.norms, following, { from: prevImgToken + 1, to: endToken + 1, anchor: 'head' });
        img.method = r.method;
        img.candidates = r.candidates.map((c) => describe(words, c, T));
        if (r.closest) img.closest = describe(words, r.closest, T);
        if (r.status === 'matched') { startToken = r.candidates[0].tokenIndex; img.status = r.method === 'fuzzy' ? 'matched_fuzzy' : 'matched'; img.score = r.candidates[0].score; }
        else { img.status = r.status; result.unresolved.push({ kind: 'image', id, status: r.status, method: r.method, candidates: img.candidates, closest: img.closest || null }); }
      }
      if (startToken === null) continue;
      prevImgToken = startToken;
      img.startWordIndex = T.wordIndex[startToken];
      img.startSeconds = words[img.startWordIndex].startSeconds;
      if (img.status === 'matched_fuzzy') result.warnings.push({ code: 'FUZZY_IMAGE_START', tag: id, message: `Image ${id} start was matched approximately. Please review.` });
    }
    prevEndToken = endToken; prevEndSeconds = entry.endSeconds;
  }

  // --- timeline (only when every item is resolved) ---
  const resolved = allImages.filter((i) => i.startSeconds !== null);
  result.images = allImages;
  if (result.unresolved.length || resolved.length !== allImages.length) return finish(result);
  if (allImages.length === 0) { result.errors.push({ code: 'NO_IMAGES', message: 'No image markers were found in the uploaded batches.' }); return finish(result); }
  for (let i = 0; i < allImages.length; i++) {
    const cur = allImages[i], next = allImages[i + 1];
    if (next && next.startSeconds <= cur.startSeconds + EPS) result.errors.push({ code: 'IMAGE_ORDER_VIOLATION', tag: next.tag, message: `Image ${next.tag} does not start after image ${cur.tag}. Check batch order and markers.` });
    cur.endSeconds = next ? next.startSeconds : durationSeconds;
    cur.renderStartSeconds = i === 0 ? 0 : cur.startSeconds;
    if (cur.endSeconds <= cur.startSeconds) result.errors.push({ code: 'NON_POSITIVE_INTERVAL', tag: cur.tag, message: `Image ${cur.tag} would have no visible duration.` });
    else if (cur.endSeconds - cur.startSeconds < minIntervalSeconds) result.warnings.push({ code: 'SHORT_INTERVAL', tag: cur.tag, message: `Image ${cur.tag} is shown for less than one video frame and may not be visible.` });
  }
  if (allImages[0].startSeconds > 0) result.warnings.push({ code: 'LEADING_GAP_FILLED', tag: allImages[0].tag, message: `Narration starts the first image at ${allImages[0].startSeconds.toFixed(2)}s; the first image is shown from 0s so there are no black frames.` });
  return finish(result);
}
function finish(r) { r.renderable = r.errors.length === 0 && r.unresolved.length === 0 && r.images.length > 0 && r.images.every((i) => Number.isFinite(i.endSeconds)); return r; }

/** Contiguous render segments covering [0, duration]. Throws on any invalid interval. */
export function buildRenderPlan(sync, imageIdByTag, durationSeconds) {
  if (!sync?.renderable) throw new Error('Synchronisation is not renderable');
  const segs = sync.images.map((i) => ({ tag: i.tag, imageId: imageIdByTag[i.tag], from: i.renderStartSeconds, to: i.endSeconds }));
  segs.forEach((s, k) => {
    if (!s.imageId) throw new Error(`No image for tag ${s.tag}`);
    if (!(s.to > s.from)) throw new Error(`Invalid interval for ${s.tag}`);
    if (k > 0 && Math.abs(s.from - segs[k - 1].to) > EPS) throw new Error(`Gap before ${s.tag}`);
  });
  if (Math.abs(segs[segs.length - 1].to - durationSeconds) > EPS) throw new Error('Final image does not reach the authoritative duration');
  return segs;
}
