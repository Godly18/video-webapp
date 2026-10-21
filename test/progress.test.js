import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeFixtures, waitFor } from './helpers.js';

test('render progress (phase, %, fps) is visible to the client while the video is being made', async () => {
  const fx = makeFixtures(45);                                    // ~45 s of audio at 1080p/30fps => a render that lasts several seconds
  const s = await startApp({ env: { RENDER_WIDTH: '1920', RENDER_HEIGHT: '1080', RENDER_FPS: '30', JOB_HEARTBEAT_SECONDS: '20' } });   // production-like heartbeat: progress must NOT depend on it
  try {
    const put = (p, buf) => s.call('PUT', p, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
    await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
    const id = (await s.call('POST', '/api/projects', { body: {} })).json.project.id;
    const getP = async () => (await s.call('GET', `/api/projects/${id}`)).json.project;
    await put(`/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav)); await waitFor(async () => (await getP()).task.audioDuration === 'finished');
    await s.call('POST', `/api/projects/${id}/audio/done`); await waitFor(async () => (await getP()).task.audioTranscription === 'finished');
    await put(`/api/projects/${id}/batches?number=1&filename=b.txt`, Buffer.from('[image_1] alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'));
    await put(`/api/projects/${id}/images?tag=1_1`, fx.read(fx.imgs.red)); await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`);
    await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } }); await waitFor(async () => (await getP()).task.batchSynchronization === 'finished');
    await s.call('POST', `/api/projects/${id}/render`);
    const seen = [];
    await waitFor(async () => { const p = await getP(); const m = p.taskMeta.videoRendering; seen.push({ t: p.task.videoRendering, phase: m.phase, pr: m.progress }); return p.task.videoRendering === 'finished'; }, { timeout: 90000, every: 150 });
    const phases = [...new Set(seen.map((x) => x.phase))];
    const withPct = seen.filter((x) => x.pr?.totalSeconds > 0 && x.pr.renderedSeconds > 0);
    console.log('phases seen:', phases, '| samples with %:', withPct.length, '/', seen.length, '| last pct sample:', JSON.stringify(withPct.at(-1)?.pr));
    assert.ok(phases.includes('encoding'), 'an "encoding" phase is reported');
    assert.ok(withPct.length >= 1, 'a percentage/fps sample reached the client during the render');
    assert.equal(withPct.at(-1).pr.fps, 30);
  } finally { await s.close(); }
});
