import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, userIdFor } from '../src/lib/email.js';
import { formatDuration, displayDuration } from '../src/lib/time.js';
import { determineDuration, buildDurationRecord, isDoneEnabled } from '../src/domain/duration.js';
import { parseTag, buildMapping } from '../src/domain/imageMapping.js';
import { parseBatchText } from '../src/domain/markers.js';
import { computeSync, buildRenderPlan } from '../src/domain/timeline.js';
import { isValidStatus, initialTasks } from '../src/domain/taskState.js';
import { extractWords, parseOffset, buildTranscript } from '../src/services/gemini.js';
import { fakeWords, WORDS } from './helpers.js';

const MAX = 1500;
// ---------- email ----------
test('email normalisation + stable hashed id', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  assert.equal(userIdFor('foo@example.com'), userIdFor(normalizeEmail(' FOO@example.com')));
  assert.match(userIdFor('a@b.co'), /^[0-9a-f]{64}$/);
  assert.equal(normalizeEmail('not-an-email'), null);
});
test('task statuses are exactly pending | finished | null (never "done")', () => {
  assert.ok(isValidStatus(null) && isValidStatus('pending') && isValidStatus('finished'));
  assert.ok(!isValidStatus('done') && !isValidStatus('null') && !isValidStatus(undefined));
  assert.deepEqual(Object.values(initialTasks()), [null, null, null, null]);
});
// ---------- duration ----------
test('format HH:MM:SS', () => { assert.equal(formatDuration(160), '00:02:40'); assert.equal(formatDuration(1500), '00:25:00'); assert.equal(formatDuration(5817), '01:36:57'); });
test('FFprobe valid duration is used and fallback is never started', async () => {
  let fb = 0;
  const r = await determineDuration({ probe: async () => ({ ok: true, seconds: 100.5 }), playback: async () => { fb++; return { ok: true, seconds: 999 }; }, maxSeconds: MAX });
  assert.deepEqual([r.seconds, r.source, fb], [100.5, 'ffprobe', 0]);
});
for (const [name, probe] of [['invalid (NaN)', { ok: true, seconds: NaN }], ['zero', { ok: true, seconds: 0 }], ['negative', { ok: true, seconds: -3 }], ['missing', { ok: false, reason: 'FFPROBE_NO_DURATION' }], ['probe failed', { ok: false, reason: 'FFPROBE_FAILED' }]])
  test(`FFprobe ${name} -> playback fallback starts`, async () => {
    let fb = 0, notified = 0;
    const r = await determineDuration({ probe: async () => probe, playback: async () => { fb++; return { ok: true, seconds: 61.2, exact: true }; }, maxSeconds: MAX, onFallback: async () => { notified++; } });
    assert.deepEqual([r.source, r.seconds, fb, notified], ['playback_fallback', 61.2, 1, 1]);
  });
test('failed fallback throws, so Done can never be enabled', async () => {
  await assert.rejects(determineDuration({ probe: async () => ({ ok: false }), playback: async () => ({ ok: false, reason: 'PLAYBACK_FAILED' }), maxSeconds: MAX }), { code: 'DURATION_UNDETERMINED' });
});
test('permanent probe failure (no audio stream) does not trigger fallback', async () => {
  let fb = 0;
  await assert.rejects(determineDuration({ probe: async () => ({ ok: false, permanent: true, reason: 'NO_AUDIO_STREAM' }), playback: async () => { fb++; return { ok: true, seconds: 5 }; }, maxSeconds: MAX }), { code: 'NO_AUDIO_STREAM' });
  assert.equal(fb, 0);
});
test('25-minute boundary: 1500 accepted, 1500.001 and 1501 rejected', () => {
  const rec = (s) => buildDurationRecord({ seconds: s, source: 'ffprobe' }, MAX, 0);
  assert.equal(rec(1500).overLimit, false);
  assert.equal(rec(1500.001).overLimit, true);
  assert.equal(rec(1501).overLimit, true);
  assert.equal(rec(1500).display, '00:25:00');
  assert.equal(rec(1501).display, '00:25:01');
  assert.equal(displayDuration(1500.4, MAX), '00:25:00.400'); // never shows an over-limit value as exactly 25:00
});
test('isDoneEnabled requires finished + valid + within limit + exact + known source', () => {
  const p = (task, duration) => ({ task: { audioDuration: task }, duration });
  const ok = { seconds: 1500, source: 'ffprobe', exact: true };
  assert.equal(isDoneEnabled(p('finished', ok), MAX), true);
  assert.equal(isDoneEnabled(p('pending', ok), MAX), false);
  assert.equal(isDoneEnabled(p(null, ok), MAX), false);
  assert.equal(isDoneEnabled(p('finished', { ...ok, seconds: 1500.5 }), MAX), false);
  assert.equal(isDoneEnabled(p('finished', { ...ok, exact: false }), MAX), false);
  assert.equal(isDoneEnabled(p('finished', { ...ok, source: 'browser' }), MAX), false);
  assert.equal(isDoneEnabled(p('finished', null), MAX), false);
});
// ---------- image mapping ----------
test('tags: numbering restarts per batch (2_1 -> batch 2 [image_1], 1_10 -> [image_10])', () => {
  assert.deepEqual(parseTag('2_1'), { batch: 2, marker: 1, tag: '2_1' });
  assert.deepEqual(parseTag('1_10'), { batch: 1, marker: 10, tag: '1_10' });
  assert.equal(parseTag('x_1'), null);
  const batches = [{ number: 1, markers: [1, 10] }, { number: 2, markers: [1, 2] }];
  const images = [['1_1', 'a'], ['1_10', 'b'], ['2_1', 'c'], ['2_2', 'd']].map(([tag, id]) => ({ id, tag }));
  const { mappings, problems } = buildMapping({ batches, images });
  assert.deepEqual(problems, []);
  const by = Object.fromEntries(mappings.map((m) => [m.tag, `${m.batch}:${m.marker}`]));
  assert.deepEqual(by, { '1_1': '1:1', '1_10': '1:10', '2_1': '2:1', '2_2': '2:2' });
});
test('mapping detects missing, duplicate, unmatched, unknown-batch and invalid tags', () => {
  const batches = [{ number: 1, markers: [1, 2] }];
  const { problems } = buildMapping({ batches, images: [{ id: 'a', tag: '1_1' }, { id: 'b', tag: '1_1' }, { id: 'c', tag: '1_9' }, { id: 'd', tag: '3_1' }, { id: 'e', tag: 'oops' }] });
  assert.deepEqual(problems.map((p) => p.code).sort(), ['DUPLICATE_TAG', 'INVALID_TAG', 'MISSING_IMAGE', 'UNKNOWN_BATCH', 'UNMATCHED_IMAGE']);
  assert.deepEqual(buildMapping({ batches, images: [{ id: 'a', tag: '1_1' }], onlyBatch: 1 }).problems.map((p) => p.tag), ['1_2']);
});
test('markers parse without altering text; duplicate / empty markers flagged', () => {
  const t = '[image_1] He looked at her.\n\n[Image_2]   The door opened.';
  const r = parseBatchText(t);
  assert.deepEqual(r.markers.map((m) => [m.number, m.tokenIndex, m.followingCount]), [[1, 0, 4], [2, 4, 3]]);
  assert.equal(parseBatchText('[image_1][image_2] hi').problems[0].code, 'MARKER_NO_SPOKEN_WORDS');
  assert.equal(parseBatchText('[image_1] a [image_1] b').problems[0].code, 'DUPLICATE_MARKER');
});
// ---------- timeline / matching ----------
const B1 = '[image_1] alpha beta gamma delta epsilon zeta eta theta [image_2] iota kappa lambda mu nu xi omicron pi';
const B2 = '[image_1] rho sigma tau upsilon';
const run = (over = {}) => computeSync({ words: fakeWords(), durationSeconds: 6, batches: [{ number: 1, text: B1 }, { number: 2, text: B2 }], ...over });
test('batch end = END of final word; image start = START of first word after marker; last image ends at authoritative duration', () => {
  const r = run();
  assert.equal(r.renderable, true, JSON.stringify(r.errors));
  assert.equal(r.batches[0].endSeconds, 4.75);   // word 15 "pi": start 4.5, end 4.75 -> END is used
  assert.equal(r.batches[1].endSeconds, 5.95);
  const t = Object.fromEntries(r.images.map((i) => [i.tag, [i.startSeconds, i.endSeconds]]));
  assert.deepEqual(t, { '1_1': [0, 2.4], '1_2': [2.4, 4.8], '2_1': [4.8, 6] }); // final image runs to 6s, past the last word (5.95)
});
test('punctuation, capitalisation and line-break differences still match', () => {
  const r = run({ batches: [{ number: 1, text: 'Alpha, BETA\ngamma;   delta! [image_1] epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi.' }, { number: 2, text: 'Rho—Sigma tau... Upsilon' }] });
  assert.equal(r.batches[0].status, 'matched');
  assert.equal(r.images[0].startSeconds, 1.2);
  assert.equal(r.images[0].status, 'matched');
});
test('repeated ending phrase is flagged ambiguous with candidate timestamps, never guessed', () => {
  const words = fakeWords('one two three four five six seven eight nine ten one two three four five six seven eight nine ten'.split(' '));
  const r = computeSync({ words, durationSeconds: 7, batches: [{ number: 1, text: '[image_1] one two three four five six seven eight nine ten' }] });
  assert.equal(r.renderable, false);
  assert.equal(r.batches[0].status, 'ambiguous');
  assert.equal(r.unresolved[0].candidates.length, 2);
  assert.ok(r.unresolved[0].candidates.every((c) => Number.isFinite(c.endSeconds) && c.context));
  // user confirms the 2nd occurrence -> the choice is honoured
  const pick = r.unresolved[0].candidates[1].wordIndex;
  const r2 = computeSync({ words, durationSeconds: 7, batches: [{ number: 1, text: '[image_1] one two three four five six seven eight nine ten' }], overrides: { batch_1: { wordIndex: pick } } });
  assert.equal(r2.batches[0].status, 'confirmed');
  assert.equal(r2.batches[0].endSeconds, words[pick].endSeconds);
});
test('later batches search only after the previous batch end (repeats across batches resolve)', () => {
  const words = fakeWords('a1 b1 c1 d1 e1 f1 g1 h1 x y z w q r s t x y z w q r s t'.split(' '));
  const r = computeSync({ words, durationSeconds: 8, batches: [{ number: 1, text: '[image_1] a1 b1 c1 d1 e1 f1 g1 h1 x y z w q r s t' }, { number: 2, text: '[image_1] x y z w q r s t' }] });
  assert.equal(r.batches[0].status, 'matched'); assert.equal(r.batches[1].status, 'matched');
  assert.ok(r.batches[1].endSeconds > r.batches[0].endSeconds);
});
test('unmatched batch is reported and blocks rendering', () => {
  const r = run({ batches: [{ number: 1, text: '[image_1] this text was never spoken in the narration at all' }] });
  assert.equal(r.renderable, false); assert.equal(r.batches[0].status, 'unmatched');
});
test('invalid / missing timestamps prevent rendering', () => {
  const bad = fakeWords(); bad[3].startSeconds = NaN;
  assert.equal(run({ words: bad }).renderable, false);
  assert.equal(run({ words: bad }).errors[0].code, 'INVALID_WORD_TIMESTAMP');
  const late = fakeWords(); assert.equal(run({ words: late, durationSeconds: 3 }).errors[0].code, 'WORD_BEYOND_AUDIO');
  assert.equal(run({ words: [] }).errors[0].code, 'NO_WORDS');
});
test('first image is shown from 0 (warned), render plan is contiguous to the authoritative duration', () => {
  const r = run({ batches: [{ number: 1, text: 'alpha beta [image_1] gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi' }, { number: 2, text: B2 }] });
  assert.equal(r.images[0].startSeconds, 0.6); assert.equal(r.images[0].renderStartSeconds, 0);
  assert.ok(r.warnings.some((w) => w.code === 'LEADING_GAP_FILLED'));
  const plan = buildRenderPlan(r, { '1_1': 'x', '2_1': 'y' }, 6);
  assert.equal(plan[0].from, 0); assert.equal(plan.at(-1).to, 6);
  assert.throws(() => buildRenderPlan(r, { '1_1': 'x', '2_1': 'y' }, 7), /authoritative/);
});
test('wrong batch order is detected, not silently accepted', () => {
  const r = run({ batches: [{ number: 2, text: B2 }, { number: 1, text: B1 }] });
  assert.equal(r.renderable, false);
});
// ---------- gemini parsing ----------
test('Gemini word_info annotations parse into normalised word records', () => {
  assert.equal(parseOffset('1.240s'), 1.24);
  const interaction = { output_text: 'Hello world', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello world', annotations: [{ type: 'word_info', text: 'Hello', start_offset: '0.100s', end_offset: '0.450s' }, { type: 'word_info', text: 'world', start_offset: '0.500s', end_offset: '0.850s' }] }] }] };
  assert.deepEqual(extractWords(interaction).map((w) => [w.word, w.startSeconds, w.endSeconds, w.index]), [['Hello', 0.1, 0.45, 0], ['world', 0.5, 0.85, 1]]);
  assert.equal(buildTranscript(interaction, 10).words.length, 2);
  assert.throws(() => buildTranscript({ output_text: 'x', steps: [] }, 10), { code: 'TRANSCRIPT_NO_WORD_TIMESTAMPS' }); // no fabricated timings
  const bad = { steps: [{ content: [{ annotations: [{ type: 'word_info', text: 'a', start_offset: '2s', end_offset: '1s' }] }] }] };
  assert.throws(() => buildTranscript(bad, 10), { code: 'TRANSCRIPT_INVALID_TIMESTAMPS' });
});

// ---------- tolerant matching (why a real ending can fail an exact match) ----------
import { resolveSequence } from '../src/domain/matcher.js';
const PRE = 'she walked into the room and everyone stopped talking at once because the silence said more than words could'.split(' ');
const END = 'meaning and where every look held a secret'.split(' ');
const syncEnd = (spoken, { duration = 12, docEnd = END } = {}) => {
  const words = fakeWords([...spoken, 'and', 'then', 'she', 'left']);
  const r = computeSync({ words, durationSeconds: duration, batches: [{ number: 1, text: '[image_1] ' + [...PRE, ...docEnd].join(' ') }] });
  return { r, words };
};
test('spoken fillers in the transcript ("um") do not break the match', () => {
  const { r, words } = syncEnd([...PRE, 'meaning', 'and', 'where', 'every', 'look', 'um', 'held', 'a', 'secret']);
  assert.equal(r.batches[0].status, 'matched');
  assert.equal(r.batches[0].endSeconds, words.find((w) => w.word === 'secret').endSeconds);
});
test('a couple of wrong/near words in the ending still match approximately and are flagged for review', () => {
  const { r, words } = syncEnd([...PRE, 'meaning', 'and', 'where', 'every', 'looks', 'held', 'the', 'secret']);
  assert.equal(r.batches[0].status, 'matched_fuzzy');
  assert.equal(r.batches[0].endSeconds, words.find((w) => w.word === 'secret').endSeconds); // still the END of the final word
  assert.ok(r.warnings.some((w) => w.code === 'FUZZY_BATCH_END'));
});
test('a badly different ending is offered as low-confidence candidates for the user to confirm (never auto-picked)', () => {
  const { r, words } = syncEnd([...PRE, 'so', 'everything', 'changed', 'after', 'that', 'awful', 'night', 'secret']);
  assert.equal(r.renderable, false);
  assert.equal(r.batches[0].status, 'ambiguous');
  assert.equal(r.unresolved[0].method, 'fuzzy_low');
  const c = r.unresolved[0].candidates[0];
  assert.ok(c.score < 0.85 && c.score >= 0.45 && c.context.includes('secret'));
  const r2 = computeSync({ words, durationSeconds: 12, batches: [{ number: 1, text: '[image_1] ' + [...PRE, ...END].join(' ') }], overrides: { batch_1: { wordIndex: c.wordIndex } } });
  assert.equal(r2.batches[0].status, 'confirmed');
});
test('completely absent ending: unmatched, shows the closest passage, and warns when the transcript stops far short of the audio', () => {
  const { r } = syncEnd('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' '), { duration: 100 });
  assert.equal(r.batches[0].status, 'unmatched');
  assert.ok(r.unresolved[0].closest && Number.isFinite(r.unresolved[0].closest.score));
  assert.ok(r.warnings.some((w) => w.code === 'TRANSCRIPT_ENDS_EARLY'));
});
test('image start with one misheard word still aligns to the FIRST word after the marker', () => {
  const words = fakeWords(['intro', 'words', 'here', 'she', 'opened', 'the', 'heavy', 'door', 'slowly', 'and', 'stepped', 'into', 'the', 'cold', 'night', 'air', 'outside']);
  const r = computeSync({ words, durationSeconds: 6, batches: [{ number: 1, text: 'intro words here [image_1] she opened the heavy doors slowly and stepped into the cold night air outside' }] });
  assert.equal(r.images[0].startSeconds, words[3].startSeconds);
  assert.equal(r.images[0].status, 'matched_fuzzy');
});
test('resolveSequence: exact beats fuzzy; short exact phrase is still exact', () => {
  const norms = 'a b c d e f g h i j'.split(' ');
  assert.equal(resolveSequence(norms, 'e f g h i j'.split(' '), { from: 0, to: 10, anchor: 'tail' }).method, 'exact');
});
