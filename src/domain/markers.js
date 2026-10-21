import { tokenizeText } from './normalize.js';
const MARKER = /\[\s*image[\s_-]*(\d+)\s*\]/gi;

/**
 * Parses a batch document without altering it.
 * tokens: normalised spoken tokens (markers removed).
 * markers[i].tokenIndex: index of the first spoken token after the marker; followingCount: spoken tokens until the next marker/end.
 */
export function parseBatchText(text) {
  const tokens = [], markers = [], problems = [];
  let last = 0, m;
  MARKER.lastIndex = 0;
  const pushSegment = (seg) => { for (const t of tokenizeText(seg)) tokens.push(t); };
  while ((m = MARKER.exec(text)) !== null) {
    pushSegment(text.slice(last, m.index));
    markers.push({ number: Number(m[1]), tokenIndex: tokens.length, charIndex: m.index });
    last = m.index + m[0].length;
  }
  pushSegment(text.slice(last));
  const seen = new Set();
  markers.forEach((mk, i) => {
    const next = markers[i + 1];
    mk.followingCount = (next ? next.tokenIndex : tokens.length) - mk.tokenIndex;
    if (seen.has(mk.number)) problems.push({ code: 'DUPLICATE_MARKER', marker: mk.number, message: `Marker [image_${mk.number}] appears more than once.` });
    seen.add(mk.number);
    if (mk.followingCount === 0) problems.push({ code: 'MARKER_NO_SPOKEN_WORDS', marker: mk.number, message: `Marker [image_${mk.number}] has no spoken words after it (before the next marker or the end).` });
  });
  return { tokens, markers, problems };
}
