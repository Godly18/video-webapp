import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, makeFixtures, waitFor } from './helpers.js';
import { batchAudioSegments } from '../src/domain/batchAudio.js';
import { createFfmpegService } from '../src/services/ffmpeg.js';
import { loadConfig } from '../src/config.js';

const fx = makeFixtures(6);
const probeDur = (f) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString());
const proj = (batches, duration = 100, task = 'finished') => ({ task: { batchSynchronization: task }, duration: { seconds: duration }, sync: { batches } });

test('segments touch exactly: first starts at 0, each starts where the previous ended, the LAST runs to the full duration', () => {
  const segs = batchAudioSegments(proj([{ number: 1, endSeconds: 30 }, { number: 2, endSeconds: 61.5 }, { number: 3, endSeconds: 97 }]));
  assert.deepEqual(segs.map((s) => [s.number, s.startSeconds, s.endSeconds]), [[1, 0, 30], [2, 30, 61.5], [3, 61.5, 100]]);   // 97 is the last word's end; trailing 3 s kept
});
test('unresolved / out-of-order batches are not offered; nothing before synchronisation finishes', () => {
  assert.deepEqual(batchAudioSegments(proj([{ number: 1, endSeconds: 30 }, { number: 2, endSeconds: null }, { number: 3, endSeconds: null }])).map((s) => s.number), [1]);
  assert.deepEqual(batchAudioSegments(proj([{ number: 1, endSeconds: 50 }, { number: 2, endSeconds: 40 }, { number: 3, endSeconds: 90 }])).map((s) => s.number), [1]);
  assert.deepEqual(batchAudioSegments(proj([{ number: 1, endSeconds: 30 }], 100, null)), []);
  assert.deepEqual(batchAudioSegments({}), []);
});
test('cutAudio is accurate on raw ADTS .aac (no index) and keeps the original untouched', async () => {
  const ff = createFfmpegService(loadConfig({ NODE_ENV: 'test' }));
  const f = path.join(fx.dir, 'raw.aac'); spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=20', '-c:a', 'aac', '-f', 'adts', f]);
  const out = path.join(fx.dir, 'cut.wav'); await ff.cutAudio({ inFile: f, outFile: out, startSeconds: 7.25, endSeconds: 12.5, format: 'wav' });
  assert.ok(Math.abs(probeDur(out) - 5.25) < 0.03, `cut length ${probeDur(out)}`);
  assert.ok(Math.abs((await ff.probeDuration(f)).seconds - 20) < 0.05);   // exact packet-based duration (plain format duration of raw .aac is only an estimate)
});

test('API: per-batch audio downloads (mp3 + wav) cover the whole narration, are cached, and respect ownership/readiness', async () => {
  let cuts = 0; const real = createFfmpegService(loadConfig({ NODE_ENV: 'test' }));
  const s = await startApp({ ffOverride: { cutAudio: async (a) => { cuts++; return real.cutAudio(a); } } });
  try {
    const put = (p, buf) => s.call('PUT', p, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
    await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
    const id = (await s.call('POST', '/api/projects', { body: {} })).json.project.id;
    const getP = async () => (await s.call('GET', `/api/projects/${id}`)).json.project;
    assert.equal((await s.call('GET', `/api/projects/${id}/batches/1/audio`)).status, 409);                               // nothing yet
    await put(`/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav)); await waitFor(async () => (await getP()).task.audioDuration === 'finished');
    await s.call('POST', `/api/projects/${id}/audio/done`); await waitFor(async () => (await getP()).task.audioTranscription === 'finished');
    await put(`/api/projects/${id}/batches?number=1&filename=chapter_part1.txt`, Buffer.from('[image_1] alpha beta gamma delta epsilon zeta eta theta [image_2] iota kappa lambda mu nu xi omicron pi'));
    await put(`/api/projects/${id}/batches?number=2&filename=chapter_part2.txt`, Buffer.from('[image_1] rho sigma tau upsilon'));
    for (const [t, f] of [['1_1', 'red'], ['1_2', 'green'], ['2_1', 'blue']]) await put(`/api/projects/${id}/images?tag=${t}`, fx.read(fx.imgs[f]));
    for (const n of [1, 2]) await s.call('POST', `/api/projects/${id}/batches/${n}/confirm-images`);
    await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } }); const p = await waitFor(async () => { const x = await getP(); return x.task.batchSynchronization === 'finished' && x; });
    assert.deepEqual(p.batchAudio.map((x) => [x.number, x.startSeconds, +x.endSeconds.toFixed(2)]), [[1, 0, 4.75], [2, 4.75, +p.duration.seconds.toFixed(2)]]);
    // wav: exact lengths, and together they make the whole narration
    const wav1 = await s.call('GET', `/api/projects/${id}/batches/1/audio?format=wav`), wav2 = await s.call('GET', `/api/projects/${id}/batches/2/audio?format=wav`);
    assert.equal(wav1.status, 200); assert.equal(wav1.headers.get('content-type'), 'audio/wav'); assert.match(wav1.headers.get('content-disposition'), /attachment; filename="chapter_part1_audio\.wav"/);
    const f1 = path.join(fx.dir, 'b1.wav'), f2 = path.join(fx.dir, 'b2.wav'); writeFileSync(f1, wav1.buf); writeFileSync(f2, wav2.buf);
    assert.ok(Math.abs(probeDur(f1) - 4.75) < 0.03, `batch1 ${probeDur(f1)}`);
    assert.ok(Math.abs(probeDur(f1) + probeDur(f2) - p.duration.seconds) < 0.05, 'segments add up to the full audio');
    // mp3 default format, served + cached
    const mp3 = await s.call('GET', `/api/projects/${id}/batches/2/audio`); assert.equal(mp3.status, 200); assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    const f3 = path.join(fx.dir, 'b2.mp3'); writeFileSync(f3, mp3.buf); assert.ok(Math.abs(probeDur(f3) - probeDur(f2)) < 0.15);
    const before = cuts; await s.call('GET', `/api/projects/${id}/batches/2/audio`); assert.equal(cuts, before, 'second download is served from the cache');
    // concurrent identical requests only cut once
    const [x, y] = await Promise.all([s.call('GET', `/api/projects/${id}/batches/1/audio?format=m4a`), s.call('GET', `/api/projects/${id}/batches/1/audio?format=m4a`)]);
    assert.deepEqual([x.status, y.status, cuts - before], [200, 200, 1]);
    // validation + ownership
    assert.equal((await s.call('GET', `/api/projects/${id}/batches/1/audio?format=ogg`)).status, 400);
    assert.equal((await s.call('GET', `/api/projects/${id}/batches/9/audio`)).status, 409);
    await s.call('POST', '/api/users/identify', { body: { email: 'other@example.com' } });
    assert.equal((await s.call('GET', `/api/projects/${id}/batches/1/audio`, { headers: { 'x-user-email': 'other@example.com' } })).status, 404);
    // the original upload is untouched
    assert.ok(await s.storage.exists((await s.db.getProject(id)).audio.key));
  } finally { await s.close(); }
});
