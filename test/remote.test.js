import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeFixtures, makeEnv, waitFor, fakeGemini } from './helpers.js';
import { JobService } from '../src/jobs/service.js';
import { registerHandlers } from '../src/jobs/handlers.js';
import { createFfmpegService } from '../src/services/ffmpeg.js';
import { createGithubDispatcher } from '../src/services/githubDispatch.js';
import { loadConfig, applyConfigSnapshot } from '../src/config.js';

const fx = makeFixtures(6);
const quiet = { error() {}, warn() {}, info() {} };
const put = (s, p, buf) => s.call('PUT', p, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
const getP = async (s, id) => (await s.call('GET', `/api/projects/${id}`)).json.project;

/** Builds a "GitHub Actions runner": a separate JobService + its own FFmpeg, sharing only Firestore(db) and R2(storage) with the web service. */
function makeRunner(s, { ff = {}, runId = 'run-1' } = {}) {
  const cfg = loadConfig(makeEnv({ RENDER_THREADS: '2', FFMPEG_LOW_PRIORITY: '0' }));
  const calls = { render: 0 };
  const real = createFfmpegService(cfg);
  const rff = { ...real, renderVideo: async (a) => { calls.render++; return (ff.renderVideo || real.renderVideo)(a); } };
  const jobs = new JobService({ db: s.db, cfg, instanceId: 'gha_' + runId, log: quiet });
  return { calls, jobs, cfg, run: async (jobId, snap) => { const job = await s.db.getJob(jobId); applyConfigSnapshot(cfg, job.cfgSnapshot); registerHandlers({ jobs, db: s.db, storage: s.storage, ff: rff, gemini: fakeGemini(), cfg }); return jobs.runAsRunner(jobId, runId); } };
}
const remoteOf = (dispatch, extra = {}) => ({ types: new Set(['videoRendering']), dispatch, startTimeoutMs: 60_000, staleMs: 60_000, pollMs: 50, fallbackLocal: true, ...extra });

async function toRenderReady(s) {
  await s.call('POST', '/api/users/identify', { body: { email: 'tester@example.com' } });
  const id = (await s.call('POST', '/api/projects', { body: {} })).json.project.id;
  await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav)); await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
  await s.call('POST', `/api/projects/${id}/audio/done`); await waitFor(async () => (await getP(s, id)).task.audioTranscription === 'finished');
  await put(s, `/api/projects/${id}/batches?number=1&filename=b.txt`, Buffer.from('[image_1] alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'));
  await put(s, `/api/projects/${id}/images?tag=1_1`, fx.read(fx.imgs.red)); await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`);
  await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } }); await waitFor(async () => (await getP(s, id)).task.batchSynchronization === 'finished');
  return id;
}
function webApp(dispatch, extra, ffOverride) {
  const local = { render: 0 }; const real = createFfmpegService(loadConfig(makeEnv()));
  return startApp({ remote: remoteOf(dispatch, extra), ffOverride: { renderVideo: async (a) => { local.render++; return real.renderVideo(a); }, ...ffOverride } }).then((s) => Object.assign(s, { local }));
}

test('REMOTE: the render runs on the runner (not on the web service), same handler, same fencing; web service only waits', async () => {
  let runner, ran, release; const gate = new Promise((r) => { release = r; });
  const s = await webApp(async ({ jobId }) => { ran = (async () => { runner ||= makeRunner(s, { ff: { renderVideo: async (a) => { await gate; return createFfmpegService(runner.cfg).renderVideo(a); } } }); return runner.run(jobId); })(); }, {});
  try {
    const id = await toRenderReady(s);
    assert.equal((await s.call('POST', `/api/projects/${id}/render`)).status, 202);
    await waitFor(async () => (await s.db.getProject(id)).taskMeta.videoRendering.progress?.totalSeconds);        // the runner's progress reaches the project
    await new Promise((r) => setTimeout(r, 2600));                                                               // > 2 web-service heartbeats (1 s in tests) while the runner is busy
    const mid = await getP(s, id);
    assert.equal(mid.task.videoRendering, 'pending');
    assert.ok(mid.taskMeta.videoRendering.progress?.totalSeconds > 0, 'web-service heartbeat must NOT wipe the runner\'s progress');
    const jobMid = await s.db.getJob((await s.db.getProject(id)).taskMeta.videoRendering.jobId);
    assert.equal(jobMid.executor, 'github'); assert.ok(jobMid.runnerRunId === 'run-1' && jobMid.remoteHeartbeatAt);
    release();
    assert.equal(await ran, 0);
    const p = await waitFor(async () => { const x = await getP(s, id); return x.task.videoRendering === 'finished' && x; });
    assert.equal(s.local.render, 0, 'web service did no rendering'); assert.equal(runner.calls.render, 1);
    const full = await s.db.getProject(id); assert.ok(await s.storage.exists(full.render.key));                    // finished only after the MP4 is in R2
    const job = await s.db.getJob(full.taskMeta.videoRendering.jobId); assert.equal(job.status, 'succeeded');
    assert.equal((await s.call('GET', `/api/projects/${id}/download`)).status, 200);
    assert.deepEqual(await runner.jobs.runAsRunner(job.id, 'run-2'), 0);                                         // a second runner for the same job does nothing
    assert.equal(runner.calls.render, 1);
  } finally { release(); await s.close(); }
});
test('REMOTE: the output settings come from the web service (config snapshot)', async () => {
  const cfg = loadConfig(makeEnv({ RENDER_WIDTH: '1920', RENDER_FPS: '30' }));
  applyConfigSnapshot(cfg, { render: { width: 640, height: 360, fps: 12, fit: 'cover', crf: 30, budgetMs: 1000 }, limits: { maxAudioSeconds: 999 } });
  assert.deepEqual([cfg.render.width, cfg.render.height, cfg.render.fps, cfg.render.fit, cfg.limits.maxAudioSeconds], [640, 360, 12, 'cover', 999]);
  assert.equal(cfg.render.threads, 1);                                                                           // performance settings stay the runner's own
});
test('REMOTE: dispatch failure -> falls back to rendering locally', async () => {
  const s = await webApp(async () => { throw new Error('GitHub dispatch failed: HTTP 401'); }, {});
  try {
    const id = await toRenderReady(s); await s.call('POST', `/api/projects/${id}/render`);
    await waitFor(async () => (await getP(s, id)).task.videoRendering === 'finished', { timeout: 40000 });
    assert.equal(s.local.render, 1);
    assert.equal((await s.db.getJob((await s.db.getProject(id)).taskMeta.videoRendering.jobId)).executor, 'local');
  } finally { await s.close(); }
});
test('REMOTE: dispatched but no runner ever starts -> local fallback after the start timeout; a late runner cannot double-run', async () => {
  const s = await webApp(async () => {}, { startTimeoutMs: 700 });
  try {
    const id = await toRenderReady(s); await s.call('POST', `/api/projects/${id}/render`);
    await waitFor(async () => (await getP(s, id)).task.videoRendering === 'finished', { timeout: 40000 });
    assert.equal(s.local.render, 1);
    const jobId = (await s.db.getProject(id)).taskMeta.videoRendering.jobId, runner = makeRunner(s);
    assert.equal(await runner.run(jobId), 0); assert.equal(runner.calls.render, 0);
  } finally { await s.close(); }
});
test('REMOTE: runner dies after claiming (heartbeat stops) -> detected, attempt 2 is dispatched and completes', async () => {
  let n = 0, runner;
  const s = await webApp(async ({ jobId }) => {
    n++;
    if (n === 1) { await s.db.updateJob(jobId, (j) => ({ runnerRunId: 'dead-run', runnerStartedAt: Date.now(), remoteHeartbeatAt: Date.now() })); return; } // claims, then goes silent forever
    runner ||= makeRunner(s, { runId: 'run-2' }); runner.run(jobId);
  }, { staleMs: 900 });
  try {
    const id = await toRenderReady(s); await s.call('POST', `/api/projects/${id}/render`);
    await waitFor(async () => (await getP(s, id)).task.videoRendering === 'finished', { timeout: 60000 });
    const job = await s.db.getJob((await s.db.getProject(id)).taskMeta.videoRendering.jobId);
    assert.equal(n, 2); assert.equal(job.attempt, 2); assert.equal(job.runnerRunId, 'run-2'); assert.equal(s.local.render, 0);
  } finally { await s.close(); }
});
test('REMOTE: runner reports a render failure -> task goes back to null with the error, never finished', async () => {
  let runner;
  const s = await webApp(async ({ jobId }) => { runner ||= makeRunner(s, { ff: { renderVideo: async () => { throw Object.assign(new Error('x'), { code: 'RENDER_FAILED' }); } } }); runner.run(jobId); }, {});
  try {
    const id = await toRenderReady(s); await s.call('POST', `/api/projects/${id}/render`);
    const p = await waitFor(async () => { const x = await getP(s, id); return x.taskMeta.videoRendering.jobStatus === 'failed' && x; });
    assert.equal(p.task.videoRendering, null); assert.equal(p.render, null); assert.equal(p.taskMeta.videoRendering.error.code, 'RENDER_FAILED');
    await new Promise((r) => setTimeout(r, 400)); assert.equal(s.local.render, 0);
    assert.equal((await getP(s, id)).task.videoRendering, null);                                               // still not finished after the web service's own wrap-up
  } finally { await s.close(); }
});
test('REMOTE: web service restart while a live runner is working does NOT requeue the job; a silent runner does', async () => {
  let release; const gate = new Promise((r) => { release = r; }); let runner, ran;
  const s = await webApp(async ({ jobId }) => { runner ||= makeRunner(s, { ff: { renderVideo: async (a) => { await gate; return createFfmpegService(runner.cfg).renderVideo(a); } } }); ran = runner.run(jobId); }, {});
  let s2;
  try {
    const id = await toRenderReady(s); await s.call('POST', `/api/projects/${id}/render`);
    const jobId = (await waitFor(async () => { const t = (await s.db.getProject(id)).taskMeta.videoRendering; return t.jobId; }));
    await waitFor(async () => (await s.db.getJob(jobId)).runnerRunId);
    await s.app.jobs.shutdown();                                                                               // web service goes down (zeroes its own heartbeat)
    s2 = await startApp({ db: s.db, storage: s.storage, env: { JOB_STALE_SECONDS: '2' }, remote: remoteOf(async () => {}) });
    assert.deepEqual(await s2.app.jobs.recover(), { retried: 0, failed: 0, cancelled: 0 });                    // runner heartbeat is fresh -> leave it alone
    release(); await ran;
    await waitFor(async () => (await s.db.getProject(id)).task.videoRendering === 'finished');                  // the runner finished it by itself
  } finally { release(); await s2?.close(); await s.close(); }
  // silent runner: remote heartbeat is old -> recovered like any other stale job
  const s3 = await startApp({ env: { JOB_STALE_SECONDS: '1' }, remote: remoteOf(async ({ jobId }) => { await s3.db.updateJob(jobId, () => ({ runnerRunId: 'zombie', remoteHeartbeatAt: Date.now() })); }) });
  try {
    const id = await toRenderReady(s3); await s3.call('POST', `/api/projects/${id}/render`);
    const jobId = (await waitFor(async () => (await s3.db.getProject(id)).taskMeta.videoRendering.jobId));
    await waitFor(async () => (await s3.db.getJob(jobId)).runnerRunId);
    await s3.app.jobs.shutdown(); await new Promise((r) => setTimeout(r, 1300));
    const s4 = await startApp({ db: s3.db, storage: s3.storage, env: { JOB_STALE_SECONDS: '1' }, remote: remoteOf(async () => {}) });
    try { assert.equal((await s4.app.jobs.recover()).retried, 1); } finally { await s4.close(); }
  } finally { await s3.close(); }
});
test('GitHub dispatcher: correct request, errors surfaced, repo validated', async () => {
  const seen = []; const ok = createGithubDispatcher({ token: 'tkn', repo: 'me/repo', workflow: 'render-job.yml', ref: 'main', fetchImpl: async (url, init) => { seen.push({ url, init }); return { status: 204, text: async () => '' }; } });
  await ok.dispatch({ job_id: 'abc' });
  assert.equal(seen[0].url, 'https://api.github.com/repos/me/repo/actions/workflows/render-job.yml/dispatches');
  assert.equal(seen[0].init.method, 'POST'); assert.equal(seen[0].init.headers.authorization, 'Bearer tkn'); assert.equal(seen[0].init.headers.accept, 'application/vnd.github+json');
  assert.deepEqual(JSON.parse(seen[0].init.body), { ref: 'main', inputs: { job_id: 'abc' } });
  const bad = createGithubDispatcher({ token: 't', repo: 'me/repo', fetchImpl: async () => ({ status: 404, text: async () => 'Not Found' }) });
  await assert.rejects(bad.dispatch({ job_id: 'x' }), /HTTP 404 Not Found/);
  assert.throws(() => createGithubDispatcher({ token: 't', repo: 'not a repo' }), /owner\/repo/);
  assert.throws(() => createGithubDispatcher({ token: '', repo: 'a/b' }), /TOKEN/);
});
