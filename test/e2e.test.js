import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, makeFixtures, waitFor, fakeGemini, fakeWords } from './helpers.js';

const B1 = '[image_1] alpha beta gamma delta epsilon zeta eta theta [image_2] iota kappa lambda mu nu xi omicron pi';
const B2 = '[image_1] rho sigma tau upsilon';
const fx = makeFixtures(6);
const put = (s, p, buf, type = 'application/octet-stream') => s.call('PUT', p, { raw: buf, headers: { 'content-type': type } });
async function newProject(s) {
  const id = await s.call('POST', '/api/users/identify', { body: { email: ' TESTER@example.com' } });
  assert.equal(id.status, 200);
  const pr = await s.call('POST', '/api/projects', { body: {} });
  assert.equal(pr.status, 201);
  return pr.json.project.id;
}
const getP = async (s, id) => (await s.call('GET', `/api/projects/${id}`)).json.project;

test('FULL WORKFLOW: email -> audio(FFprobe) -> Done -> transcript -> batches -> images -> sync -> render -> R2/Firestore state -> download', async () => {
  const s = await startApp();
  try {
    const id = await newProject(s);
    // audio
    const up = await put(s, `/api/projects/${id}/audio?filename=narration.wav`, fx.read(fx.wav));
    assert.equal(up.status, 202);
    assert.equal(up.json.project.task.audioDuration, 'pending'); // returned immediately, work is in the background
    let p = await waitFor(async () => { const x = await getP(s, id); return x.task.audioDuration === 'finished' && x; });
    assert.equal(p.duration.source, 'ffprobe'); assert.ok(Math.abs(p.duration.seconds - 6) < 0.2); assert.equal(p.doneEnabled, true);
    assert.match(p.duration.display, /^00:00:0[5-6]$/);
    // original audio really is in storage and only metadata is in the DB
    const dbp = await s.db.getProject(id);
    assert.ok(await s.storage.exists(dbp.audio.key)); assert.match(dbp.audio.key, new RegExp(`^users/${dbp.userId}/projects/${id}/audio/`));
    assert.equal(JSON.stringify(dbp).includes('RIFF'), false);
    // Done -> transcription starts
    assert.equal((await s.call('POST', `/api/projects/${id}/audio/done`)).status, 200);
    p = await waitFor(async () => { const x = await getP(s, id); return x.task.audioTranscription === 'finished' && x; });
    assert.equal(p.stage, 'batches'); assert.equal(p.transcript.wordCount, 20);
    // batches (2 before 1 to prove order is explicit via numbers)
    assert.equal((await put(s, '/api/projects/' + id + '/batches?number=2&filename=batch_2.txt', Buffer.from(B2))).status, 201);
    assert.equal((await put(s, '/api/projects/' + id + '/batches?number=1&filename=batch_1.txt', Buffer.from(B1))).status, 201);
    p = await getP(s, id); assert.deepEqual(p.batchOrder, [1, 2]);
    assert.equal((await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'images' } })).status, 200);
    // images: wrong things are refused
    assert.equal((await put(s, `/api/projects/${id}/images?tag=1_1`, Buffer.from('not an image'))).json.error.code, 'INVALID_IMAGE');
    assert.equal((await put(s, `/api/projects/${id}/images?tag=9_1`, fx.read(fx.imgs.red))).json.error.code, 'UNKNOWN_BATCH');
    // Done for batch 1 with a missing image is rejected
    await put(s, `/api/projects/${id}/images?tag=1_1&filename=a.png`, fx.read(fx.imgs.red));
    const bad = await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`);
    assert.equal(bad.status, 422); assert.match(bad.json.error.message, /\[image_2\]/);
    assert.equal((await put(s, `/api/projects/${id}/images?tag=1_1`, fx.read(fx.imgs.red))).json.error.code, 'DUPLICATE_TAG');
    await put(s, `/api/projects/${id}/images?tag=1_2&filename=b.png`, fx.read(fx.imgs.green));
    await put(s, `/api/projects/${id}/images?tag=2_1&filename=c.png`, fx.read(fx.imgs.blue));
    assert.equal((await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`)).status, 200);
    assert.equal((await s.call('POST', `/api/projects/${id}/batches/2/confirm-images`)).json.mappings[0].marker, 1); // 2_1 -> batch 2's [image_1]
    // review -> sync
    assert.equal((await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } })).status, 200);
    p = await waitFor(async () => { const x = await getP(s, id); return x.task.batchSynchronization === 'finished' && x; });
    assert.equal(p.sync.renderable, true, JSON.stringify(p.sync.errors));
    assert.deepEqual(p.sync.images.map((i) => [i.tag, i.startSeconds, +i.endSeconds.toFixed(2)]).map(([t, a, b]) => [t, a, b === p.duration.seconds.toFixed(2) * 1 ? 'END' : b]), [['1_1', 0, 2.4], ['1_2', 2.4, 4.8], ['2_1', 4.8, 'END']]);
    assert.equal(p.sync.batches[0].endSeconds, 4.75);
    // render
    assert.equal((await s.call('POST', `/api/projects/${id}/render`)).status, 202);
    assert.equal((await s.call('GET', `/api/projects/${id}/download`)).status, 409); // not ready: nothing served prematurely
    p = await waitFor(async () => { const x = await getP(s, id); return x.task.videoRendering === 'finished' && x; }, { timeout: 60000 });
    const full = await s.db.getProject(id);
    assert.ok(await s.storage.exists(full.render.key), 'MP4 is stored (finished only after upload)');
    assert.equal(full.taskMeta.videoRendering.jobStatus, 'succeeded');
    const dl = await s.call('GET', `/api/projects/${id}/download`);
    assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'video/mp4');
    const out = path.join(fx.dir, 'out.mp4'); writeFileSync(out, dl.buf);
    const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', out]).stdout);
    const v = pr.streams.find((x) => x.codec_type === 'video'), a = pr.streams.find((x) => x.codec_type === 'audio');
    assert.deepEqual([v.codec_name, a.codec_name, v.width, v.height], ['h264', 'aac', 320, 240]);
    assert.ok(Math.abs(Number(pr.format.duration) - p.duration.seconds) < 0.35, `video ${pr.format.duration}s vs audio ${p.duration.seconds}s`); // complete audio kept, final image lasts to the end
    // the three-state vocabulary only
    for (const v of Object.values(full.task)) assert.ok([null, 'pending', 'finished'].includes(v));
    assert.equal(JSON.stringify(p).includes(full.render.key), false); // keys never leak to the client
  } finally { await s.close(); }
});

test('FALLBACK: FFprobe cannot read duration -> async playback fallback; Done disabled meanwhile; API stays responsive; survives page "leave"', async () => {
  const wav3 = makeFixtures(3).wav;
  const s = await startApp({ ffOverride: { probeDuration: async () => ({ ok: false, reason: 'FFPROBE_NO_DURATION' }) } });
  try {
    const id = await newProject(s);
    assert.equal((await put(s, `/api/projects/${id}/audio?filename=a.wav`, fx.read(wav3))).status, 202);
    const pending = await waitFor(async () => { const x = await getP(s, id); return x.taskMeta.audioDuration.phase === 'playback_fallback' && x; });
    assert.equal(pending.task.audioDuration, 'pending'); assert.equal(pending.doneEnabled, false);
    assert.equal((await s.call('POST', `/api/projects/${id}/audio/done`)).status, 409); // backend enforces it independently
    // user "leaves": beacon + a fresh identify must not start another job
    await fetch(s.base + `/api/projects/${id}/leave`, { method: 'POST', body: JSON.stringify({ email: 'tester@example.com' }) });
    const before = (await s.db.listJobsByStatus(['queued', 'running'])).length;
    const back = await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
    assert.equal(back.json.project.task.audioDuration, 'pending'); assert.equal(back.json.project.taskMeta.audioDuration.phase, 'playback_fallback');
    assert.equal((await s.call('POST', `/api/projects/${id}/audio/retry`)).status, 202);
    assert.equal((await s.db.listJobsByStatus(['queued', 'running'])).length, before, 'no duplicate job for a pending task');
    // API responsive while the 3s playback runs
    const t0 = Date.now(); const h = await fetch(s.base + '/health'); assert.equal(h.status, 200); assert.ok(Date.now() - t0 < 500);
    const done = await waitFor(async () => { const x = await getP(s, id); return x.task.audioDuration === 'finished' && x; }, { timeout: 15000 });
    assert.equal(done.duration.source, 'playback_fallback'); assert.ok(Math.abs(done.duration.seconds - 3) < 0.8, `measured ${done.duration.seconds}`);
    assert.equal(done.doneEnabled, true);
  } finally { await s.close(); }
});
test('FALLBACK failure never enables Done and never marks the task finished', async () => {
  const s = await startApp({ ffOverride: { probeDuration: async () => ({ ok: false }), measurePlayback: async () => ({ ok: false, reason: 'PLAYBACK_FAILED' }) } });
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=a.wav`, fx.read(fx.wav));
    const p = await waitFor(async () => { const x = await getP(s, id); return x.taskMeta.audioDuration.jobStatus === 'failed' && x; });
    assert.equal(p.task.audioDuration, null); assert.equal(p.doneEnabled, false); assert.equal(p.taskMeta.audioDuration.error.code, 'DURATION_UNDETERMINED');
    assert.equal((await s.call('POST', `/api/projects/${id}/audio/done`)).status, 409);
  } finally { await s.close(); }
});
test('over-limit audio: duration saved, task finished, Done disabled, backend refuses', async () => {
  const s = await startApp({ env: { MAX_AUDIO_SECONDS: '4' } });
  try {
    const id = await newProject(s);
    await put(s, `/api/projects/${id}/audio?filename=a.wav`, fx.read(fx.wav));
    const p = await waitFor(async () => { const x = await getP(s, id); return x.task.audioDuration === 'finished' && x; });
    assert.equal(p.duration.overLimit, true); assert.equal(p.doneEnabled, false);
    assert.equal((await s.call('POST', `/api/projects/${id}/audio/done`)).json.error.code, 'DURATION_NOT_VERIFIED');
    assert.equal((await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'batches' } })).status, 409);
  } finally { await s.close(); }
});
test('unsupported / empty uploads are rejected; other users cannot touch a project; unidentified calls refused', async () => {
  const s = await startApp();
  try {
    const id = await newProject(s);
    assert.equal((await put(s, `/api/projects/${id}/audio?filename=evil.exe`, Buffer.from('x'))).status, 415);
    assert.equal((await put(s, `/api/projects/${id}/audio?filename=a.wav`, Buffer.alloc(0))).status, 400);
    assert.equal((await s.call('GET', `/api/projects/${id}`, { headers: { 'x-user-email': 'nobody@example.com' } })).status, 401);
    await s.call('POST', '/api/users/identify', { body: { email: 'other@example.com' } });
    assert.equal((await s.call('GET', `/api/projects/${id}`, { headers: { 'x-user-email': 'other@example.com' } })).status, 404);
    assert.equal((await s.call('POST', '/api/users/identify', { body: { email: 'bad' } })).status, 400);
    assert.equal((await fetch(s.base + '/health')).status, 200);
    assert.deepEqual(await (await fetch(s.base + '/health')).json(), { status: 'ok' });
  } finally { await s.close(); }
});

test('transcript .txt download (plain + timestamps) is available only when ready, and only to its owner', async () => {
  const s = await startApp();
  try {
    const id = await newProject(s);
    assert.equal((await s.call('GET', `/api/projects/${id}/transcript-text`)).status, 409);
    await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav));
    await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
    await s.call('POST', `/api/projects/${id}/audio/done`);
    await waitFor(async () => (await getP(s, id)).task.audioTranscription === 'finished');
    const plain = await s.call('GET', `/api/projects/${id}/transcript-text`);
    assert.equal(plain.status, 200); assert.match(plain.headers.get('content-type'), /text\/plain/); assert.match(plain.headers.get('content-disposition'), /attachment; filename="transcript\.txt"/);
    assert.equal(plain.buf.toString().trim(), fakeWords().map((w) => w.word).join(' '));
    const ts = await s.call('GET', `/api/projects/${id}/transcript-text?timestamps=1`);
    assert.match(ts.buf.toString(), /^\[00:00:00\.000\] alpha beta/); assert.match(ts.buf.toString(), /\n\[00:00:03\.600\] /); // 12 words * 0.3s
    await s.call('POST', '/api/users/identify', { body: { email: 'other@example.com' } });
    assert.equal((await s.call('GET', `/api/projects/${id}/transcript-text`, { headers: { 'x-user-email': 'other@example.com' } })).status, 404);
  } finally { await s.close(); }
});
