import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, makeFixtures, waitFor } from './helpers.js';
import { presignGetUrl } from '../src/lib/sigv4.js';
import { makePresigner } from '../src/storage/r2.js';

const fx = makeFixtures(6);
const put = (s, p, buf) => s.call('PUT', p, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
const getP = async (s, id) => (await s.call('GET', `/api/projects/${id}`)).json.project;
async function toRenderReady(s, email = 'tester@example.com') {
  await s.call('POST', '/api/users/identify', { body: { email } });
  const id = (await s.call('POST', '/api/projects', { body: {} })).json.project.id;
  await put(s, `/api/projects/${id}/audio?filename=n.wav`, fx.read(fx.wav)); await waitFor(async () => (await getP(s, id)).task.audioDuration === 'finished');
  await s.call('POST', `/api/projects/${id}/audio/done`); await waitFor(async () => (await getP(s, id)).task.audioTranscription === 'finished');
  await put(s, `/api/projects/${id}/batches?number=1&filename=chapter1.txt`, Buffer.from('[image_1] alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'));
  await put(s, `/api/projects/${id}/images?tag=1_1`, fx.read(fx.imgs.red)); await s.call('POST', `/api/projects/${id}/batches/1/confirm-images`);
  await s.call('POST', `/api/projects/${id}/stage`, { body: { stage: 'review' } }); await waitFor(async () => (await getP(s, id)).task.batchSynchronization === 'finished');
  return id;
}
const renderAndWait = async (s, id, n = 1) => { await s.call('POST', `/api/projects/${id}/render`); await waitFor(async () => { const p = await getP(s, id); return p.task.videoRendering === 'finished' && p.render?.outputId && (await s.db.listVideosByUser((await s.db.getProject(id)).userId)).length >= n; }, { timeout: 60000 }); };

test('presigned URL: matches the AWS documented example; R2 path-style URL has bucket in the path, signed response-* overrides and no secrets', () => {
  const aws = presignGetUrl({ endpoint: 'https://examplebucket.s3.amazonaws.com', bucket: 'examplebucket', key: 'test.txt', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expiresSeconds: 86400, now: new Date('2013-05-24T00:00:00Z'), pathStyle: false });
  assert.ok(aws.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'));
  const url = new URL(makePresigner({ r2: { endpoint: 'https://acc123.r2.cloudflarestorage.com', bucket: 'vids', accessKeyId: 'AKID', secretAccessKey: 'SECRETSECRET' } })('users/u1/videos/out 1.mp4', { filename: 'my "video".mp4', contentType: 'video/mp4', expiresSeconds: 600 }));
  assert.equal(url.host, 'acc123.r2.cloudflarestorage.com'); assert.equal(url.pathname, '/vids/users/u1/videos/out%201.mp4');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '600'); assert.equal(url.searchParams.get('response-content-type'), 'video/mp4');
  assert.equal(url.searchParams.get('response-content-disposition'), 'attachment; filename="my _video_.mp4"');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/); assert.ok(!url.href.includes('SECRETSECRET'));
});

test('LIBRARY: a finished render lands in "Videos"; starting a new project and project cleanup never remove it', async () => {
  const s = await startApp();
  try {
    const id = await toRenderReady(s);
    assert.deepEqual((await s.call('GET', '/api/videos')).json.videos, []);
    await s.call('POST', `/api/projects/${id}/render`);
    const second = (await s.call('POST', '/api/projects', { body: { replace: true } })).json.project.id;        // user clicks "Start a new project" while the render is still running
    assert.notEqual(second, id);
    await waitFor(async () => (await s.db.listVideosByUser((await s.db.getProject(id)).userId)).length === 1, { timeout: 60000 });
    const list = (await s.call('GET', '/api/videos')).json;
    assert.equal(list.videos.length, 1); assert.equal(list.retentionDays, 7);
    const v = list.videos[0]; assert.equal(v.title, 'chapter1'); assert.ok(v.size > 1000 && v.width === 320 && v.fps === 10 && v.durationSeconds > 5);
    assert.equal(JSON.stringify(list).includes('users/'), false, 'no storage keys leak');
    // the old project is expired and cleaned up...
    await waitFor(async () => (await getP(s, second)).id === second);
    await s.db.updateProject(id, () => ({ expiresAt: Date.now() - 1 }));
    await waitFor(async () => (await s.db.getJob((await s.db.getProject(id)).taskMeta.videoRendering.jobId)).status === 'succeeded');
    const c = await s.cleanup(); assert.equal(c.cleaned, 1);
    const proj = await s.db.getProject(id); assert.equal(proj.state, 'cleaned'); assert.deepEqual(await s.storage.listPrefix(`users/${proj.userId}/projects/${id}/`), []);
    // ...but the video is still there and downloadable
    const dl = await s.call('GET', `/api/videos/${v.id}/download`); assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'video/mp4'); assert.ok(dl.buf.length === v.size);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="chapter1_\d{4}-\d{2}-\d{2}\.mp4"/);
  } finally { await s.close(); }
});

test('DIRECT DOWNLOADS: ?link=1 returns a short-lived storage link (nothing streams through the server); local storage falls back to streaming', async () => {
  const s = await startApp(); const calls = [];
  try {
    const id = await toRenderReady(s); await renderAndWait(s, id);
    const vid = (await s.call('GET', '/api/videos')).json.videos[0];
    // storage without presign support (dev/local): link=1 still works by streaming
    const fallback = await s.call('GET', `/api/videos/${vid.id}/download?link=1`); assert.equal(fallback.status, 200); assert.equal(fallback.headers.get('content-type'), 'video/mp4'); assert.equal(fallback.buf.length, vid.size);
    // storage with presign support (R2)
    s.storage.presignGet = async (key, opts) => { calls.push({ key, ...opts }); return `https://files.example/${key}?sig=abc`; };
    const r = await s.call('GET', `/api/videos/${vid.id}/download?link=1`);
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /json/);
    assert.equal(r.json.mode, 'redirect'); assert.match(r.json.url, /^https:\/\/files\.example\/users\/.+\/videos\/.+\.mp4\?sig=abc$/); assert.equal(r.json.expiresInSeconds, 600);
    assert.equal(calls[0].contentType, 'video/mp4'); assert.match(calls[0].filename, /^chapter1_\d{4}-\d{2}-\d{2}\.mp4$/); assert.equal(calls[0].expiresSeconds, 600);
    // project download + batch audio use the same mechanism
    const pd = await s.call('GET', `/api/projects/${id}/download?link=1`); assert.equal(pd.json.mode, 'redirect'); assert.equal(calls.at(-1).filename, 'video.mp4');
    const ba = await s.call('GET', `/api/projects/${id}/batches/1/audio?link=1&format=mp3`); assert.equal(ba.json.mode, 'redirect'); assert.match(calls.at(-1).filename, /^chapter1_audio\.mp3$/); assert.equal(calls.at(-1).contentType, 'audio/mpeg');
    // without link=1 the old streaming behaviour is unchanged
    assert.equal((await s.call('GET', `/api/projects/${id}/download`)).headers.get('content-type'), 'video/mp4');
  } finally { await s.close(); }
});

test('LIBRARY: ownership, delete, retention expiry and the per-user limit', async () => {
  let t = Date.now(); const clock = () => t;
  const s = await startApp({ clock, env: { MAX_VIDEOS_PER_USER: '1' } });
  try {
    const id = await toRenderReady(s); await renderAndWait(s, id);
    const first = (await s.call('GET', '/api/videos')).json.videos[0];
    t += 1000; await renderAndWait(s, id, 1);                                                          // a second render pushes the first out (limit 1)
    await waitFor(async () => { const l = (await s.call('GET', '/api/videos')).json.videos; return l.length === 1 && l[0].id !== first.id; });
    const cur = (await s.call('GET', '/api/videos')).json.videos[0];
    assert.equal(await s.storage.exists(`users/${(await s.db.getProject(id)).userId}/videos/${first.id}.mp4`), false, 'trimmed video file is gone');
    await s.call('POST', '/api/users/identify', { body: { email: 'other@example.com' } });
    const other = { 'x-user-email': 'other@example.com' };
    assert.equal((await s.call('GET', `/api/videos/${cur.id}/download`, { headers: other })).status, 404);
    assert.equal((await s.call('DELETE', `/api/videos/${cur.id}`, { headers: other })).status, 404);
    assert.deepEqual((await s.call('GET', '/api/videos', { headers: other })).json.videos, []);
    t += 8 * 86_400_000;                                                                               // past the 7-day retention
    assert.deepEqual((await s.call('GET', '/api/videos')).json.videos, []);
    assert.equal((await s.call('GET', `/api/videos/${cur.id}/download`)).status, 404);
    const c = await s.cleanup(); assert.equal(c.videosDeleted, 1); assert.equal(await s.db.getVideo(cur.id), null);
  } finally { await s.close(); }
  const s2 = await startApp();
  try {
    const id = await toRenderReady(s2); await renderAndWait(s2, id);
    const v = (await s2.call('GET', '/api/videos')).json.videos[0];
    assert.equal((await s2.call('DELETE', `/api/videos/${v.id}`)).status, 200);
    assert.deepEqual((await s2.call('GET', '/api/videos')).json.videos, []); assert.equal((await s2.call('GET', `/api/projects/${id}/download`)).status, 404);   // the project's own link now says "gone"
  } finally { await s2.close(); }
});
