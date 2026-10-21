import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeFixtures, waitFor, fakeGemini, fakeWords } from './helpers.js';
import { createFfmpegService } from '../src/services/ffmpeg.js';
import { loadConfig } from '../src/config.js';

const fx = makeFixtures(6);
const put = (s, p, buf) => s.call('PUT', p, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
const getP = async (s, id) => (await s.call('GET', `/api/projects/${id}`)).json.project;
async function newProject(s, email = 'tester@example.com') {
  await s.call('POST', '/api/users/identify', { body: { email } });
  return (await s.call('POST', '/api/projects', { body: {} })).json.project.id;
}
async function toReview(s, id, { text = '[image_1] alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon' } = {}) {
  await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
  await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
  await s.call('POST', `/api/projects/${id}/audio/done`);
  await waitFor(async () => (await getP(s, id)).task.audioTranscription === 'finished');
  await put(s, `/api/projects/${id}/batches?number=1&filename=b.txt`, Buffer.from(text));
  await put(s, `/api/projects/${id}/images?tag=1_1`, fx.read(fx.imgs.red));
  await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`);
  await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } });
  return waitFor(async () => { const p = await getP(s, id); return p.task.batchSynchronization === 'finished' && p; });
}

test('RESTART: stale pending job is detected and safely retried; the superseded attempt cannot overwrite the result', async () => {
  let release;
  const hung = { probeDuration: () => new Promise((r) => { release = () => r({ ok: true, seconds: 999 }); }) };
  const s1 = await startApp({ env: { JOB_HEARTBEAT_SECONDS: '3600', JOB_STALE_SECONDS: '1' }, ffOverride: hung });
  const id = await newProject(s1);
  await put(s1, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
  await waitFor(async () => (await s1.db.getProject(id)).taskMeta.audioDuration.jobStatus === 'running');
  await new Promise((r) => setTimeout(r, 1300)); // "process died": no heartbeats, heartbeat now older than JOB_STALE_SECONDS
  const s2 = await startApp({ env: { JOB_STALE_SECONDS: '1' }, db: s1.db, storage: s1.storage });
  try {
    assert.equal((await getP(s2, id)).task.audioDuration, 'pending', 'still pending, NOT marked finished by the restart');
    const r = await s2.app.jobs.recover();
    assert.deepEqual(r, { retried: 1, failed: 0, cancelled: 0 });
    const p = await waitFor(async () => { const x = await getP(s2, id); return x.task.audioDuration === 'finished' && x; });
    assert.ok(Math.abs(p.duration.seconds - 6) < 0.2);
    const job = await s2.db.getJob(p.taskMeta.audioDuration ? (await s2.db.getProject(id)).taskMeta.audioDuration.jobId : '');
    assert.equal(job.attempt, 2); assert.equal(job.interruptions, 1);
    release(); await new Promise((r) => setTimeout(r, 400)); // the zombie attempt 1 wakes up with a bogus 999s result
    assert.ok(Math.abs((await getP(s2, id)).duration.seconds - 6) < 0.2, 'fenced: zombie attempt cannot overwrite');
  } finally { release?.(); await s1.close(); await s2.close(); }
});
test('RESTART with no attempts left: task goes back to null with interrupted metadata, never finished', async () => {
  const s1 = await startApp({ env: { JOB_HEARTBEAT_SECONDS: '3600', JOB_STALE_SECONDS: '1' }, ffOverride: { probeDuration: () => new Promise(() => {}) } });
  const id = await newProject(s1);
  await put(s1, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
  await waitFor(async () => (await s1.db.getProject(id)).taskMeta.audioDuration.jobStatus === 'running');
  await new Promise((r) => setTimeout(r, 1300));
  const s2 = await startApp({ env: { JOB_STALE_SECONDS: '1', JOB_MAX_ATTEMPTS: '1' }, db: s1.db, storage: s1.storage });
  try {
    assert.deepEqual(await s2.app.jobs.recover(), { retried: 0, failed: 1, cancelled: 0 });
    const p = await getP(s2, id);
    assert.equal(p.task.audioDuration, null); assert.equal(p.taskMeta.audioDuration.jobStatus, 'interrupted'); assert.equal(p.doneEnabled, false);
    assert.equal((await s2.call('POST', `/api/projects/${id}/audio/retry`)).status, 202); // controlled retry from the stored R2 audio
    await waitFor(async () => (await getP(s2, id)).task.audioDuration === 'finished');
  } finally { await s1.close(); await s2.close(); }
});
test('updating one task does not reset unrelated task states', async () => {
  const s = await startApp({});
  try {
    const id = await newProject(s);
    await toReview(s, id);
    await s.call('POST', `/api/projects/${id}/audio/retry`); // re-runs ONLY the duration task
    await waitFor(async () => { const p = await s.db.getProject(id); return p.taskMeta.audioDuration.jobStatus === 'succeeded'; });
    const p = await s.db.getProject(id);
    assert.deepEqual([p.task.audioDuration, p.task.audioTranscription, p.task.batchSynchronization, p.task.videoRendering], ['finished', 'finished', 'finished', null]);
  } finally { await s.close(); }
});
test('rendering failure or failed R2 upload never yields finished; retry is possible', async () => {
  const s = await startApp({ env: { JOB_MAX_ATTEMPTS: '1' }, ffOverride: { renderVideo: async () => { throw Object.assign(new Error('boom'), { code: 'RENDER_FAILED' }); } } });
  try {
    const id = await newProject(s); await toReview(s, id);
    await s.call('POST', `/api/projects/${id}/render`);
    let p = await waitFor(async () => { const x = await getP(s, id); return x.taskMeta.videoRendering.jobStatus === 'failed' && x; });
    assert.equal(p.task.videoRendering, null); assert.equal(p.render, null); assert.equal((await s.call('GET', `/api/projects/${id}/download`)).status, 409);
    assert.equal(p.taskMeta.videoRendering.error.code, 'RENDER_FAILED');
  } finally { await s.close(); }
  // upload to storage fails after a good ffmpeg run
  const base = await startApp({});
  const flaky = { ...base.storage, putFile: async (k, ...a) => { if (k.includes('/videos/')) throw new Error('R2 down'); return base.storage.putFile(k, ...a); }, putBuffer: (...a) => base.storage.putBuffer(...a), getBuffer: (...a) => base.storage.getBuffer(...a), downloadTo: (...a) => base.storage.downloadTo(...a), openStream: (...a) => base.storage.openStream(...a), exists: (...a) => base.storage.exists(...a), delete: (...a) => base.storage.delete(...a), deletePrefix: (...a) => base.storage.deletePrefix(...a) };
  await base.close();
  const s2 = await startApp({ env: { JOB_MAX_ATTEMPTS: '1' }, storage: flaky });
  try {
    const id = await newProject(s2); await toReview(s2, id);
    await s2.call('POST', `/api/projects/${id}/render`);
    const p = await waitFor(async () => { const x = await getP(s2, id); return x.taskMeta.videoRendering.jobStatus === 'failed' && x; });
    assert.equal(p.task.videoRendering, null); assert.equal(p.render, null);
  } finally { await s2.close(); }
});
test('ambiguous ending is surfaced; confirming a candidate is persisted and unlocks rendering; non-candidates refused', async () => {
  const words = fakeWords('one two three four five six seven eight nine ten one two three four five six seven eight nine ten'.split(' '));
  const s = await startApp({ gemini: fakeGemini(words) });
  try {
    const id = await newProject(s);
    const p = await toReview(s, id, { text: '[image_1] one two three four five six seven eight nine ten' });
    assert.equal(p.sync.renderable, false); assert.equal(p.sync.unresolved[0].kind, 'batch'); assert.equal(p.sync.unresolved[0].candidates.length, 2);
    assert.equal((await s.call('POST', `/api/projects/${id}/render`)).status, 409); // blocked
    assert.equal((await s.call('POST', `/api/projects/${id}/sync/resolve`, { body: { kind: 'batch', id: 1, wordIndex: 3 } })).status, 409);
    const pick = p.sync.unresolved[0].candidates[0].wordIndex;
    const r = await s.call('POST', `/api/projects/${id}/sync/resolve`, { body: { kind: 'batch', id: 1, wordIndex: pick } });
    assert.equal(r.status, 200); assert.equal(r.json.project.sync.renderable, true);
    assert.deepEqual((await s.db.getProject(id)).overrides, { batch_1: { wordIndex: pick } }); // saved persistently
    assert.equal(r.json.project.sync.batches[0].endSeconds, words[pick].endSeconds);
  } finally { await s.close(); }
});
test('EXPIRY: within 1h progress is restored without new jobs; after 1h it is not resumable and files are cleaned up (idempotently)', async () => {
  let t = Date.now(); const clock = () => t;
  const s = await startApp({ clock });
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
    await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
    const jobsBefore = s.db.jobs.size;
    t += 59 * 60_000;
    const back = await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
    assert.equal(back.json.project.id, id); assert.equal(back.json.project.task.audioDuration, 'finished'); assert.equal(back.json.project.doneEnabled, true);
    assert.equal(s.db.jobs.size, jobsBefore, 'finished duration check is not repeated');
    const prefix = `users/${(await s.db.getProject(id)).userId}/projects/${id}/`;
    assert.ok((await s.storage.listPrefix(prefix)).length > 0);
    t += 61 * 60_000; // > 1h since the last activity
    assert.equal((await s.call('GET', `/api/projects/${id}`)).status, 410);
    const gone = await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
    assert.equal(gone.json.expired, true); assert.equal(gone.json.project, null);
    assert.equal((await s.call('POST', '/api/internal/cleanup', {})).status, 403);
    const c = await s.call('POST', '/api/internal/cleanup', { headers: { 'x-cron-secret': 'secret' } });
    assert.deepEqual(c.json, { cleaned: 1, skippedActive: 0, failed: 0, videosDeleted: 0 });
    assert.deepEqual(await s.storage.listPrefix(prefix), []);
    assert.equal((await s.db.getProject(id)).state, 'cleaned');
    assert.deepEqual(await s.cleanup(), { cleaned: 0, skippedActive: 0, failed: 0, videosDeleted: 0 }); // idempotent
    assert.equal((await s.call('POST', '/api/projects', { body: {} })).status, 201); // can start fresh
  } finally { await s.close(); }
});
test('CLEANUP never deletes inputs of a live job and retries failed deletions', async () => {
  let release;
  const s = await startApp({ ffOverride: { probeDuration: () => new Promise((r) => { release = () => r({ ok: true, seconds: 6 }); }) } });
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
    await waitFor(async () => (await s.db.getProject(id)).taskMeta.audioDuration.jobStatus === 'running');
    await s.db.updateProject(id, () => ({ expiresAt: Date.now() - 1000 })); // force "expired" while the job is live
    const key = (await s.db.getProject(id)).audio.key;
    assert.deepEqual(await s.cleanup(), { cleaned: 0, skippedActive: 1, failed: 0, videosDeleted: 0 });
    assert.ok(await s.storage.exists(key));
    release();
    await waitFor(async () => (await s.db.getProject(id)).task.audioDuration === 'finished');
    await s.db.updateProject(id, () => ({ expiresAt: Date.now() - 1000 }));
    let fail = true; const realDel = s.storage.deletePrefix.bind(s.storage);
    s.storage.deletePrefix = async (p) => { if (fail) throw new Error('R2 hiccup'); return realDel(p); };
    assert.equal((await s.cleanup()).failed, 1); assert.ok(await s.storage.exists(key));
    fail = false; assert.equal((await s.cleanup()).cleaned, 1); assert.equal(await s.storage.exists(key), false);
  } finally { release?.(); await s.close(); }
});
test('playback measurement is real-time, valid only after reaching the end, and is capped (lower bound => never a fabricated duration)', async () => {
  const cfg = loadConfig({ NODE_ENV: 'test' }); const ff = createFfmpegService(cfg);
  const wav = makeFixtures(3).wav;
  const full = await ff.measurePlayback(wav, { maxSeconds: 30 });
  assert.equal(full.ok, true); assert.equal(full.exact, true); assert.ok(full.seconds > 2.7 && full.seconds < 3.8, `elapsed ${full.seconds}`); // ~real time, not instant
  const capped = await ff.measurePlayback(wav, { maxSeconds: 1 });
  assert.deepEqual([capped.ok, capped.exact, capped.seconds], [true, false, 1]);
  const missing = await ff.measurePlayback('/nonexistent.wav', { maxSeconds: 5 });
  assert.equal(missing.ok, false);
  assert.equal((await ff.probeDuration('/nonexistent.wav')).ok, false);
});

// ---- regression: raw/ADTS .aac has no real duration; format=duration is an estimate (a 5:27 file showed as 5:17) ----
import { spawnSync } from 'node:child_process';
import path from 'node:path';
function makeVbrAdts(dir) {
  const f = path.join(dir, 'chapter.aac');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink:a=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-filter_complex', '[1]atrim=0:40[s];[0]aformat=sample_rates=44100:channel_layouts=mono[n];[s][n]concat=n=2:v=0:a=1', '-c:a', 'aac', '-q:a', '0.3', '-f', 'adts', f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return f; // true length: 60.0 s
}
test('ADTS .aac: probe uses the exact packet end, not the bitrate-estimated format duration', async () => {
  const cfg = loadConfig({ NODE_ENV: 'test' }); const ff = createFfmpegService(cfg);
  const f = makeVbrAdts(fx.dir);
  const r = await ff.probeDuration(f);
  assert.equal(r.ok, true); assert.equal(r.method, 'ffprobe_packets');
  assert.ok(Math.abs(r.seconds - 60) < 0.1, `exact duration ${r.seconds}`);
  assert.ok(Math.abs(r.formatSeconds - 60) > 5, `format estimate (${r.formatSeconds}) should be visibly wrong for this file, proving the old code path was inaccurate`);
});
test('ADTS .aac uploaded through the API stores the exact duration', async () => {
  const s = await startApp({});
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=chapter1.aac`, fx.read(makeVbrAdts(fx.dir)));
    const p = await waitFor(async () => { const x = await getP(s, id); return x.task.audioDuration === 'finished' && x; });
    assert.equal(p.duration.source, 'ffprobe'); assert.equal(p.duration.method, 'ffprobe_packets'); assert.ok(Math.abs(p.duration.seconds - 60) < 0.1);
  } finally { await s.close(); }
});

// ---- regression: transcription must receive audio with an exact length (raw ADTS made the transcript stop ~10 s early) ----
import { execFileSync } from 'node:child_process';
test('transcription is sent an exact-length WAV (not the raw ADTS), original upload untouched; force re-transcribe resets sync', async () => {
  let seen;
  const words = fakeWords();
  const gemini = { transcribe: async ({ filePath, filename, durationSeconds }) => { seen = { filename, dur: Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', filePath])).format.duration), durationSeconds }; return { text: words.map((x) => x.word).join(' '), words, model: 'fake' }; } };
  const s = await startApp({ gemini });
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=chapter1.aac`, fx.read(makeVbrAdts(fx.dir)));
    await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
    await s.call('POST', `/api/projects/${id}/audio/done`);
    await waitFor(async () => (await getP(s, id)).task.audioTranscription === 'finished');
    assert.equal(seen.filename, 'transcribe.wav'); assert.ok(Math.abs(seen.dur - 60) < 0.1, `wav length ${seen.dur}`);
    const stored = await s.db.getProject(id); assert.match(stored.audio.filename, /chapter1\.aac$/); assert.ok(await s.storage.exists(stored.audio.key)); // original kept for the video
    // force re-transcribe
    seen = null;
    assert.equal((await s.call('POST', `/api/projects/${id}/transcribe?force=1`)).status, 202);
    await waitFor(async () => { const p = await getP(s, id); return p.task.audioTranscription === 'finished' && p.taskMeta.audioTranscription.jobStatus === 'succeeded' && seen; });
  } finally { await s.close(); }
});
