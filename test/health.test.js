import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, makeFixtures, waitFor } from './helpers.js';
import { run } from '../src/services/ffmpeg.js';
import { fpsLadder, nextFps, projectTotalMs } from '../src/domain/renderPlanner.js';
import { createFfmpegService } from '../src/services/ffmpeg.js';
import { loadConfig } from '../src/config.js';

async function startGate(appPort) {
  const w = new Worker(new URL('../src/healthGate.js', import.meta.url), { workerData: { port: 0, host: '127.0.0.1', target: appPort } });
  const port = await new Promise((res, rej) => { w.once('message', (m) => (m.listening ? res(m.port) : rej(new Error(m.error)))); w.once('error', rej); });
  return { port, stop: () => w.terminate() };
}
const lag = (ms) => { const t = Date.now(); while (Date.now() - t < ms); };

test('HEALTH GATE: /health is answered by the worker thread even while the main thread is completely blocked', async () => {
  const s = await startApp();
  const gate = await startGate(s.app.server.address().port);
  try {
    // an independent process measures /health latency while THIS (main) thread busy-loops for 2.5 s
    const script = `const t=Date.now();setTimeout(async()=>{const s=Date.now();const r=await fetch('http://127.0.0.1:${gate.port}/health');const j=await r.json();console.log(JSON.stringify({status:r.status,body:j,ms:Date.now()-s}));},300);`;
    const child = spawn(process.execPath, ['-e', script]); let out = ''; child.stdout.on('data', (d) => { out += d; });
    const done = new Promise((r) => child.on('close', r));
    lag(2500);                                   // main event loop (and the app server inside it) is frozen
    await done;
    const r = JSON.parse(out);
    assert.equal(r.status, 200); assert.deepEqual(r.body, { status: 'ok' }); assert.ok(r.ms < 500, `health took ${r.ms}ms while the main thread was blocked`);
  } finally { await gate.stop(); await s.close(); }
});
test('HEALTH GATE: full workflow works through the proxy (upload, polling, download), IP header forwarded, upstream errors -> 502', async () => {
  const fx = makeFixtures(3);
  const s = await startApp();
  const gate = await startGate(s.app.server.address().port);
  const base = `http://127.0.0.1:${gate.port}`;
  const H = { 'x-user-email': 'gate@example.com' };
  try {
    assert.equal((await fetch(base + '/health', { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + '/')).status, 200);                                     // static UI through the proxy
    const idr = await (await fetch(base + '/api/users/identify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gate@example.com' }) })).json();
    assert.equal(idr.isNewUser, true);
    const pid = (await (await fetch(base + '/api/projects', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' })).json()).project.id;
    const body = fx.read(fx.wav);
    const up = await fetch(`${base}/api/projects/${pid}/audio?filename=a.wav`, { method: 'PUT', headers: { ...H, 'content-type': 'application/octet-stream' }, body });
    assert.equal(up.status, 202);
    const p = await waitFor(async () => { const x = (await (await fetch(`${base}/api/projects/${pid}`, { headers: H })).json()).project; return x.task.audioDuration === 'finished' && x; });
    assert.equal((await s.db.getProject(pid)).audio.size, body.length);                       // every byte arrived through the proxy
    assert.ok(Math.abs(p.duration.seconds - 3) < 0.2);
    assert.equal((await fetch(`${base}/api/projects/${pid}/download`, { headers: H })).status, 409); // app errors pass through unchanged
  } finally { await s.close(); }
  const dead = await fetch(base + '/api/config');                                              // app server is gone now
  assert.equal(dead.status, 502); assert.equal((await dead.json()).error.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal((await fetch(base + '/health')).status, 200);                                   // ...but the health check still answers
  await gate.stop();
});
test('heavy FFmpeg runs at lowest CPU priority (nice 19); normal commands are unaffected', async () => {
  const r = await run('cat', ['/proc/self/stat'], { lowPriority: true });
  const niceVal = Number(r.stdout.slice(r.stdout.lastIndexOf(')') + 2).split(' ')[16]);           // field 19 of /proc/<pid>/stat
  assert.equal(niceVal, 19);
  const plain = await run('cat', ['/proc/self/stat']);
  assert.equal(Number(plain.stdout.slice(plain.stdout.lastIndexOf(')') + 2).split(' ')[16]), 0);
});
test('render planner: fps ladder, projection and step-down choice', () => {
  assert.deepEqual(fpsLadder(30).slice(0, 4), [30, 25, 24, 15]);
  assert.equal(projectTotalMs({ elapsedMs: 10_000, renderedSeconds: 50, totalSeconds: 300 }), null);          // too early to judge
  assert.equal(projectTotalMs({ elapsedMs: 60_000, renderedSeconds: 30, totalSeconds: 300 }), 600_000);
  // projected 50 min at 30 fps, 25 min left -> need <= ~19 min at the new rate: 15 fps = 25*1.3 > 25 so go to 10 fps
  assert.equal(nextFps({ currentFps: 30, projectedMs: 50 * 60_000, remainingMs: 25 * 60_000 }), 10);
  assert.equal(nextFps({ currentFps: 30, projectedMs: 30 * 60_000, remainingMs: 25 * 60_000 }), 15);
  assert.equal(nextFps({ currentFps: 2, projectedMs: 9e9, remainingMs: 1, configuredFps: 30 }), null);       // nothing cheaper left
  assert.equal(nextFps({ currentFps: 30, projectedMs: 9e9, remainingMs: 1 }), 2);                           // hopeless -> cheapest
});
test('renderVideo aborts with RENDER_TOO_SLOW when projected beyond budget, and a lower fps then finishes (handler steps fps down + warns)', async () => {
  const fx = makeFixtures(6);
  const real = createFfmpegService(loadConfig({ NODE_ENV: 'test', RENDER_WIDTH: '1280', RENDER_HEIGHT: '720', RENDER_FPS: '30' }));
  // direct: tiny budget + tiny sample window => projected overrun
  const work = fx.dir; const seg = [{ file: fx.imgs.red, from: 0, to: 3 }, { file: fx.imgs.green, from: 3, to: 6 }];
  await assert.rejects(real.renderVideo({ segments: seg, audioPath: fx.wav, outPath: path.join(work, 'x.mp4'), workDir: work, totalSeconds: 6, budgetMs: 1, minSampleMs: 0, fps: 30 }), (e) => e.code === 'RENDER_TOO_SLOW' && e.projectedMs > 1);
  // through the job handler
  const calls = [];
  const s = await startApp({ env: { RENDER_FPS: '30' }, ffOverride: { renderVideo: async (a) => { calls.push(a.fps); if (calls.length === 1) throw Object.assign(new Error('slow'), { code: 'RENDER_TOO_SLOW', projectedMs: 50 * 60_000, elapsedMs: 40_000, fps: a.fps }); return real.renderVideo(a); } } });
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
    const p = await waitFor(async () => { const x = await getP(); return x.task.videoRendering === 'finished' && x; }, { timeout: 60000 });
    assert.equal(calls.length, 2); assert.ok(calls[1] < calls[0], `fps stepped down ${calls}`);
    assert.equal(p.render.fps, calls[1]); assert.ok(p.render.warnings.some((w) => /fps/.test(w)));
    const out = path.join(fx.dir, 'o.mp4'); writeFileSync(out, (await s.call('GET', `/api/projects/${id}/download`)).buf);
    const info = await real.inspect(out); const v = info.streams.find((x) => x.codec_type === 'video');
    assert.equal(eval(v.r_frame_rate), calls[1]);
    assert.ok(Math.abs(info.duration - p.duration.seconds) < 0.4);
  } finally { await s.close(); }
});
