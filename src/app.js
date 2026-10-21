import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from './lib/errors.js';
import { DELETE } from './lib/patch.js';
import { open as openFile } from 'node:fs/promises';
import { normalizeEmail, userIdFor } from './lib/email.js';
import { newId, safeFilename } from './lib/ids.js';
import { formatDuration } from './lib/time.js';
import { initialTasks, initialTaskMeta, isExpired, nextExpiry, STAGES } from './domain/taskState.js';
import { isDoneEnabled } from './domain/duration.js';
import { parseBatchText } from './domain/markers.js';
import { parseTag, buildMapping } from './domain/imageMapping.js';
import { mimeForFilename } from './services/gemini.js';
import { computeProjectSync, projectMapping, orderedBatches } from './services/sync.js';
import { JobService } from './jobs/service.js';
import { createGithubDispatcher } from './services/githubDispatch.js';
import { registerHandlers } from './jobs/handlers.js';
import { cleanupExpired } from './jobs/cleanup.js';
import { sendJson, readJson, readBody, receiveToFile, RateLimiter, serveStatic, serveIndex } from './http.js';
import { BUILD } from './version.js';
import { projectView } from './view.js';
import { batchAudioSegments, AUDIO_FORMATS } from './domain/batchAudio.js';
import { withTmp } from './jobs/handlers.js';
import { createHash } from 'node:crypto';

const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm', 'opus', 'aiff', 'aif']);
const sniffImage = (b) => {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', type: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
};
const RESET_SYNC = { sync: null, overrides: {}, 'task.batchSynchronization': null, 'taskMeta.batchSynchronization': {}, render: null, 'task.videoRendering': null, 'taskMeta.videoRendering': {} };

function buildRemote(cfg, log) {
  const r = cfg.remote;
  if (!r.types.size) return null;
  if (!r.token || !r.repo) { log.warn?.('REMOTE_JOB_TYPES is set but GH_DISPATCH_TOKEN / GH_REPO are missing: running all jobs on this server.'); return null; }
  const d = createGithubDispatcher({ token: r.token, repo: r.repo, workflow: r.workflow, ref: r.ref });
  log.info?.(`remote jobs on GitHub Actions (${r.repo}/${r.workflow}): ${[...r.types].join(', ')}`);
  return { types: r.types, dispatch: ({ jobId }) => d.dispatch({ job_id: jobId }), startTimeoutMs: r.startTimeoutMs, staleMs: r.staleMs, pollMs: r.pollMs, fallbackLocal: r.fallbackLocal };
}

export function createApp({ cfg, db, storage, gemini, ff, now = Date.now, log = console, remote }) {
  const jobs = new JobService({ db, cfg, now, log, remote: remote === undefined ? buildRemote(cfg, log) : remote });
  registerHandlers({ jobs, db, storage, ff, gemini, cfg, now });
  const general = new RateLimiter(600, 60_000, now), identifyLimiter = new RateLimiter(20, 60_000, now);
  let uploading = 0;
  const prefixOf = (p) => `users/${p.userId}/projects/${p.id}/`;

  // ---------- auth / project access ----------
  async function authUser(req) {
    const email = normalizeEmail(req.headers['x-user-email']);
    if (!email) throw new AppError(401, 'IDENTIFY_REQUIRED', 'Please enter your email to continue.');
    const userId = userIdFor(email);
    const user = await db.getUser(userId);
    if (!user) throw new AppError(401, 'IDENTIFY_REQUIRED', 'Please enter your email to continue.');
    return { userId, email, user };
  }
  async function getProject(userId, id) {
    const p = await db.getProject(id);
    if (!p || p.userId !== userId) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    const t = now();
    if (isExpired(p, t)) {
      if (p.state === 'active') await db.updateProject(p.id, (c) => (c.state === 'active' ? { state: 'expired', expiredAt: t } : null)).catch(() => {});
      throw new AppError(410, 'PROJECT_EXPIRED', 'This task has expired. Please start a new upload.');
    }
    if (t - (p.lastActivityAt || 0) > 30_000) { // server-side activity tracking (status polling counts as presence)
      await db.updateProject(p.id, (c) => ({ lastActivityAt: t, expiresAt: nextExpiry(c.expiresAt, t, cfg.limits.returnWindowMs) })).catch(() => {});
    }
    return p;
  }
  /** Send a stored file. With ?link=1 (and a storage provider that supports it) reply with a short-lived direct link so the bytes never pass through this server. */
  async function sendFile(res, query, { key, type, filename }) {
    if (!(await storage.exists(key))) throw new AppError(404, 'FILE_GONE', 'This file is no longer available.');
    if (query.get('link') === '1' && cfg.downloads.viaStorage && storage.presignGet) {
      const url = await storage.presignGet(key, { filename, contentType: type, expiresSeconds: cfg.downloads.linkSeconds });
      return sendJson(res, 200, { mode: 'redirect', url, expiresInSeconds: cfg.downloads.linkSeconds });
    }
    const { stream, size } = await storage.openStream(key);
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store' });
    stream.pipe(res);
  }
  const notPending = (p, ...types) => { for (const t of types) if (p.task[t] === 'pending') throw new AppError(409, 'TASK_IN_PROGRESS', 'Please wait for the current task to finish.'); };
  const sendView = async (res, userId, id, status = 200) => sendJson(res, status, { project: projectView(await db.getProject(id), cfg, now()) });
  const deleteKeys = (keys) => Promise.all(keys.filter(Boolean).map((k) => storage.delete(k).catch(() => {})));
  async function withUploadSlot(fn) {
    if (uploading >= cfg.limits.maxConcurrentUploads) throw new AppError(503, 'BUSY', 'The server is busy receiving other uploads. Please retry in a moment.');
    uploading++; const dir = await mkdtemp(path.join(tmpdir(), 'up-'));
    try { return await fn(dir); } finally { uploading--; await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler, auth });

  route('GET', '/health', async ({ res }) => sendJson(res, 200, { status: 'ok' }), { auth: false });
  route('GET', '/api/version', async ({ res }) => sendJson(res, 200, { build: BUILD, commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null }), { auth: false });
  route('GET', '/api/config', async ({ res }) => sendJson(res, 200, { maxAudioSeconds: cfg.limits.maxAudioSeconds, returnWindowMinutes: Math.round(cfg.limits.returnWindowMs / 60000), maxAudioMB: Math.round(cfg.limits.maxAudioBytes / 1048576), maxImageMB: Math.round(cfg.limits.maxImageBytes / 1048576) }), { auth: false });

  // Email-only identification (intentionally open: the email is an identifier, not proof of ownership).
  route('POST', '/api/users/identify', async ({ req, res, ip }) => {
    if (!identifyLimiter.allow(ip)) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a minute.');
    const email = normalizeEmail((await readJson(req)).email);
    if (!email) throw new AppError(400, 'INVALID_EMAIL', 'Please enter a valid email address.');
    const userId = userIdFor(email), t = now();
    const user = await db.upsertUser(userId, { email, lastActivityAt: t }, { createdAt: t, activeProjectId: null });
    let project = null, expired = false;
    if (user.activeProjectId) {
      const p = await db.getProject(user.activeProjectId);
      if (p && p.userId === userId && !isExpired(p, t)) { project = p; await db.updateProject(p.id, (c) => ({ lastActivityAt: t, expiresAt: nextExpiry(c.expiresAt, t, cfg.limits.returnWindowMs) })); }
      else { expired = true; if (p?.state === 'active') await db.updateProject(p.id, (c) => (c.state === 'active' ? { state: 'expired', expiredAt: t } : null)).catch(() => {}); await db.upsertUser(userId, { activeProjectId: null }); }
    }
    sendJson(res, 200, { email, isNewUser: user.createdAt === t, expired, project: project ? projectView(await db.getProject(project.id), cfg, now()) : null });
  }, { auth: false });

  route('POST', '/api/projects', async ({ req, res, auth }) => {
    const body = await readJson(req);
    const u = await db.getUser(auth.userId);
    if (u.activeProjectId) {
      const cur = await db.getProject(u.activeProjectId);
      if (cur && cur.userId === auth.userId && !isExpired(cur, now())) {
        if (!body.replace) return sendView(res, auth.userId, cur.id);
        await db.updateProject(cur.id, () => ({ expiresAt: now() })); // old project becomes eligible for cleanup (skipped while its jobs are live)
      }
    }
    const t = now(), id = newId('prj');
    await db.createProject({ id, userId: auth.userId, createdAt: t, lastActivityAt: t, expiresAt: t + cfg.limits.returnWindowMs, state: 'active', stage: 'audio',
      task: initialTasks(), taskMeta: initialTaskMeta(), audio: null, duration: null, transcript: null, batches: {}, batchOrder: [], images: {}, overrides: {}, sync: null, render: null });
    await db.upsertUser(auth.userId, { activeProjectId: id, lastActivityAt: t });
    await sendView(res, auth.userId, id, 201);
  });
  route('GET', '/api/projects/:id', async ({ res, auth, params }) => { const p = await getProject(auth.userId, params.id); sendJson(res, 200, { project: projectView(p, cfg, now()) }); });
  route('GET', '/api/projects/:id/audio/duration-status', async ({ res, auth, params }) => { const v = projectView(await getProject(auth.userId, params.id), cfg, now()); sendJson(res, 200, { task: v.task.audioDuration, meta: v.taskMeta.audioDuration, duration: v.duration, doneEnabled: v.doneEnabled }); });
  // Best-effort page-exit beacon (sendBeacon cannot set headers, so the email is in the body). Never cancels jobs.
  route('POST', '/api/projects/:id/leave', async ({ req, res, params }) => {
    const email = normalizeEmail((await readJson(req)).email);
    if (email) { try { await getProject(userIdFor(email), params.id); } catch { /* ignore */ } }
    res.writeHead(204).end();
  }, { auth: false });

  // ---------- Stage 1: audio ----------
  route('PUT', '/api/projects/:id/audio', async ({ req, res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    notPending(p, 'audioDuration', 'audioTranscription', 'batchSynchronization', 'videoRendering');
    const filename = safeFilename(query.get('filename'), 'audio');
    const ext = filename.split('.').pop().toLowerCase();
    if (!AUDIO_EXT.has(ext)) throw new AppError(415, 'UNSUPPORTED_AUDIO', `Unsupported audio type. Use: ${[...AUDIO_EXT].join(', ')}.`);
    await withUploadSlot(async (dir) => {
      const tmp = path.join(dir, 'audio');
      const size = await receiveToFile(req, tmp, cfg.limits.maxAudioBytes);
      const key = `${prefixOf(p)}audio/${newId('a')}-${filename}`;
      await storage.putFile(key, tmp, { contentType: mimeForFilename(filename) || 'application/octet-stream' });
      let r;
      try {
        r = await jobs.start(auth.userId, p.id, 'audioDuration', {
          guard: (c) => notPending(c, 'audioDuration', 'audioTranscription', 'batchSynchronization', 'videoRendering'),
          patch: { audio: { key, filename, size, uploadedAt: now() }, duration: null, transcript: null, ...RESET_SYNC, stage: 'audio', 'task.audioTranscription': null, 'taskMeta.audioTranscription': {} },
        });
      } catch (e) { await deleteKeys([key]); throw e; }
      if (!r.started) { await deleteKeys([key]); throw new AppError(409, 'TASK_IN_PROGRESS', 'A duration check is already running.'); }
      await deleteKeys([p.audio?.key, p.transcript?.key]);
    });
    await sendView(res, auth.userId, p.id, 202);
  });
  route('POST', '/api/projects/:id/audio/retry', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    if (!p.audio) throw new AppError(409, 'NO_AUDIO', 'Upload an audio file first.');
    await jobs.start(auth.userId, p.id, 'audioDuration', { patch: { duration: null } });
    await sendView(res, auth.userId, p.id, 202);
  });
  // The UI "Done" button. Re-validated here; the server never trusts the frontend's enabled state.
  route('POST', '/api/projects/:id/audio/done', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    if (!isDoneEnabled(p, cfg.limits.maxAudioSeconds)) throw new AppError(409, 'DURATION_NOT_VERIFIED', 'The audio duration has not been verified within the 25-minute limit.');
    if (p.task.audioTranscription !== 'finished' && p.task.audioTranscription !== 'pending') await jobs.start(auth.userId, p.id, 'audioTranscription');
    await db.updateProject(p.id, (c) => (c.stage === 'audio' ? { stage: 'batches' } : null));
    await sendView(res, auth.userId, p.id);
  });
  route('POST', '/api/projects/:id/transcribe', async ({ res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    if (!isDoneEnabled(p, cfg.limits.maxAudioSeconds)) throw new AppError(409, 'DURATION_NOT_VERIFIED', 'The audio duration has not been verified.');
    if (query.get('force') === '1') { // re-transcribe (e.g. after an incomplete transcript): invalidates synchronisation/render, keeps documents and images
      await jobs.start(auth.userId, p.id, 'audioTranscription', { guard: (c) => notPending(c, 'batchSynchronization', 'videoRendering'), patch: { ...RESET_SYNC } });
    } else if (p.task.audioTranscription !== 'finished') await jobs.start(auth.userId, p.id, 'audioTranscription');
    await sendView(res, auth.userId, p.id, 202);
  });
  route('GET', '/api/projects/:id/transcript', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    if (p.task.audioTranscription !== 'finished') throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'The transcript is not ready.');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(await storage.getBuffer(p.transcript.key));
  });

  // Downloadable transcript (.txt). Plain = the model's verbatim text; ?timestamps=1 = one line per ~12 words with the start time of each line.
  route('GET', '/api/projects/:id/transcript-text', async ({ res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    if (p.task.audioTranscription !== 'finished' || !p.transcript?.key) throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'The transcript is not ready.');
    const t = JSON.parse((await storage.getBuffer(p.transcript.key)).toString('utf8'));
    const stamped = query.get('timestamps') === '1';
    let body;
    if (stamped) {
      const lines = [];
      for (let i = 0; i < t.words.length; i += 12) { const chunk = t.words.slice(i, i + 12); lines.push(`[${formatDuration(chunk[0].startSeconds, { precise: true })}] ${chunk.map((w) => w.word).join(' ')}`); }
      body = lines.join('\n');
    } else body = (t.text && t.text.trim()) || t.words.map((w) => w.word).join(' ');
    const buf = Buffer.from(body + '\n', 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': buf.length, 'content-disposition': `attachment; filename="${stamped ? 'transcript_with_timestamps' : 'transcript'}.txt"`, 'cache-control': 'no-store' });
    res.end(buf);
  });

  // ---------- Stage 2: text batches ----------
  route('PUT', '/api/projects/:id/batches', async ({ req, res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    notPending(p, 'batchSynchronization', 'videoRendering');
    const number = Number(query.get('number'));
    if (!Number.isInteger(number) || number < 1 || number > 9999) throw new AppError(400, 'INVALID_BATCH_NUMBER', 'Batch number must be a positive whole number.');
    if (p.batches[`b${number}`] && query.get('replace') !== '1') throw new AppError(409, 'BATCH_NUMBER_EXISTS', `Batch ${number} already exists. Choose another number or replace it.`);
    if (!p.batches[`b${number}`] && Object.keys(p.batches).length >= cfg.limits.maxBatches) throw new AppError(422, 'TOO_MANY_BATCHES', 'Too many batches.');
    const buf = await readBody(req, cfg.limits.maxDocBytes);
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); } catch { throw new AppError(415, 'NOT_UTF8_TEXT', 'The batch document must be a UTF-8 text file.'); }
    const parsed = parseBatchText(text);
    if (parsed.tokens.length === 0) throw new AppError(422, 'EMPTY_BATCH', 'The document contains no spoken words.');
    if (parsed.problems.length) throw new AppError(422, 'BATCH_MARKER_PROBLEM', parsed.problems[0].message, { details: parsed.problems });
    const filename = safeFilename(query.get('filename'), `batch_${number}.txt`);
    const key = `${prefixOf(p)}documents/${newId('d')}-${filename}`;
    await storage.putBuffer(key, buf, { contentType: 'text/plain; charset=utf-8' });
    const order = p.batchOrder.includes(number) ? p.batchOrder : [...p.batchOrder, number].sort((a, b) => a - b);
    await db.updateProject(p.id, () => ({ [`batches.b${number}`]: { number, filename, key, size: buf.length, uploadedAt: now(), wordCount: parsed.tokens.length, markers: parsed.markers.map((m) => m.number), endPhrase: parsed.tokens.slice(-8).join(' '), imagesConfirmed: false }, batchOrder: order, ...RESET_SYNC, ...(['review', 'export'].includes(p.stage) ? { stage: 'batches' } : {}) }));
    await deleteKeys([p.batches[`b${number}`]?.key]);
    await sendView(res, auth.userId, p.id, 201);
  });
  route('POST', '/api/projects/:id/batches/order', async ({ req, res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); notPending(p, 'batchSynchronization', 'videoRendering');
    const order = (await readJson(req)).order;
    if (!Array.isArray(order) || order.length !== p.batchOrder.length || [...order].sort().join() !== [...p.batchOrder].sort().join()) throw new AppError(400, 'INVALID_ORDER', 'Order must list every uploaded batch number exactly once.');
    await db.updateProject(p.id, () => ({ batchOrder: order.map(Number), ...RESET_SYNC }));
    await sendView(res, auth.userId, p.id);
  });
  route('DELETE', '/api/projects/:id/batches/:number', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); notPending(p, 'batchSynchronization', 'videoRendering');
    const b = p.batches[`b${params.number}`]; if (!b) throw new AppError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
    const imgs = Object.values(p.images).filter((i) => i.batch === b.number);
    const patch = { batchOrder: p.batchOrder.filter((n) => n !== b.number), [`batches.b${b.number}`]: DELETE, ...RESET_SYNC };
    for (const i of imgs) patch[`images.${i.id}`] = DELETE;
    await db.updateProject(p.id, () => patch);
    await deleteKeys([b.key, ...imgs.map((i) => i.key)]); await sendView(res, auth.userId, p.id);
  });

  // Audio of ONE batch (cut from the original narration at the synchronised boundaries). Cached in R2 for the retention window; computed on first request.
  const cutting = new Map();
  route('GET', '/api/projects/:id/batches/:number/audio', async ({ res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    const n = Number(params.number), seg = batchAudioSegments(p).find((x) => x.number === n);
    if (!seg) throw new AppError(409, 'BATCH_AUDIO_NOT_READY', 'This batch\'s audio is not available yet. Synchronize first (and resolve any unmatched batch ending before it).');
    const fmt = query.get('format') || cfg.batchAudioFormat, spec = AUDIO_FORMATS[fmt];
    if (!spec) throw new AppError(400, 'INVALID_FORMAT', 'Format must be mp3, wav or m4a.');
    const tag = createHash('sha1').update(p.audio.key).digest('hex').slice(0, 10);
    const key = `${prefixOf(p)}outputs/batch-audio/${tag}_${n}_${Math.round(seg.startSeconds * 1000)}_${Math.round(seg.endSeconds * 1000)}.${spec.ext}`;
    if (!(await storage.exists(key))) {
      if (!cutting.has(key)) {
        cutting.set(key, withTmp(async (dir) => {
          const src = path.join(dir, 'audio'), out = path.join(dir, `out.${spec.ext}`);
          await storage.downloadTo(p.audio.key, src);
          try { await ff.cutAudio({ inFile: src, outFile: out, startSeconds: seg.startSeconds, endSeconds: seg.endSeconds, format: fmt }); }
          catch { throw new AppError(500, 'AUDIO_CUT_FAILED', 'The audio could not be cut. Please try again.'); }
          await storage.putFile(key, out, { contentType: spec.type });
        }).finally(() => cutting.delete(key)));
      }
      await cutting.get(key);
    }
    const stem = safeFilename((p.batches[`b${n}`]?.filename || `batch_${n}`).replace(/\.[^.]+$/, ''), `batch_${n}`);
    await sendFile(res, query, { key, type: spec.type, filename: `${stem}_audio.${spec.ext}` });
  });

  // ---------- Stage 3: images ----------
  route('PUT', '/api/projects/:id/images', async ({ req, res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id); notPending(p, 'batchSynchronization', 'videoRendering');
    const tag = parseTag(query.get('tag'));
    if (!tag) throw new AppError(400, 'INVALID_TAG', 'Image tag must look like 1_1 (batch number, underscore, image number).');
    const batch = p.batches[`b${tag.batch}`];
    if (!batch) throw new AppError(422, 'UNKNOWN_BATCH', `Batch ${tag.batch} has not been uploaded.`);
    const existing = Object.values(p.images).find((i) => i.tag === tag.tag);
    if (existing && query.get('replace') !== '1') throw new AppError(409, 'DUPLICATE_TAG', `Tag ${tag.tag} is already used. Delete that image or replace it.`);
    if (!existing && Object.keys(p.images).length >= cfg.limits.maxImages) throw new AppError(422, 'TOO_MANY_IMAGES', 'Too many images.');
    await withUploadSlot(async (dir) => {
      const tmp = path.join(dir, 'img');
      const size = await receiveToFile(req, tmp, cfg.limits.maxImageBytes);
      const fh = await openFile(tmp, 'r'); const head = Buffer.alloc(16); await fh.read(head, 0, 16, 0); await fh.close();
      const kind = sniffImage(head);
      if (!kind) throw new AppError(415, 'INVALID_IMAGE', 'Only valid PNG, JPEG or WebP images are accepted.');
      const id = newId('img');
      const key = `${prefixOf(p)}images/${id}.${kind.ext}`;
      await storage.putFile(key, tmp, { contentType: kind.type });
      const patch = { [`images.${id}`]: { id, tag: tag.tag, batch: tag.batch, marker: tag.marker, filename: safeFilename(query.get('filename'), `${tag.tag}.${kind.ext}`), key, ext: kind.ext, contentType: kind.type, size, uploadedAt: now() }, [`batches.b${tag.batch}.imagesConfirmed`]: false, ...RESET_SYNC, ...(['review', 'export'].includes(p.stage) ? { stage: 'images' } : {}) };
      if (existing) patch[`images.${existing.id}`] = DELETE;
      await db.updateProject(p.id, () => patch);
      await deleteKeys([existing?.key]);
    });
    await sendView(res, auth.userId, p.id, 201);
  });
  route('DELETE', '/api/projects/:id/images/:imageId', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); notPending(p, 'batchSynchronization', 'videoRendering');
    const img = p.images[params.imageId]; if (!img) throw new AppError(404, 'IMAGE_NOT_FOUND', 'Image not found.');
    await db.updateProject(p.id, () => ({ [`images.${img.id}`]: DELETE, ...RESET_SYNC }));
    await deleteKeys([img.key]); await sendView(res, auth.userId, p.id);
  });
  route('GET', '/api/projects/:id/images/:imageId/file', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); const img = p.images[params.imageId];
    if (!img) throw new AppError(404, 'IMAGE_NOT_FOUND', 'Image not found.');
    const { stream, size } = await storage.openStream(img.key);
    res.writeHead(200, { 'content-type': img.contentType, 'content-length': size, 'cache-control': 'private, max-age=300' }); stream.pipe(res);
  });
  // Per-batch "Done": maps tags to markers (numbering restarts in each batch) and refuses missing/duplicate/unmatched images.
  route('POST', '/api/projects/:id/batches/:number/confirm-images', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); const n = Number(params.number);
    if (!p.batches[`b${n}`]) throw new AppError(404, 'BATCH_NOT_FOUND', 'Batch not found.');
    const { problems, mappings } = buildMapping({ batches: orderedBatches(p).map((b) => ({ number: b.number, markers: b.markers })), images: Object.values(p.images).map((i) => ({ id: i.id, tag: i.tag })), onlyBatch: n });
    if (problems.length) throw new AppError(422, 'MAPPING_INVALID', problems[0].message, { details: problems });
    await db.updateProject(p.id, () => ({ [`batches.b${n}.imagesConfirmed`]: true }));
    sendJson(res, 200, { mappings, project: projectView(await db.getProject(p.id), cfg, now()) });
  });

  // ---------- stage navigation ----------
  const canEnter = (p, stage) => {
    const audioOk = isDoneEnabled(p, cfg.limits.maxAudioSeconds);
    if (stage === 'audio') return null;
    if (!audioOk) return 'Verify the audio duration first.';
    if (stage === 'batches') return null;
    if (!p.batchOrder.length) return 'Upload at least one text batch first.';
    if (stage === 'images') return null;
    if (!p.batchOrder.every((n) => p.batches[`b${n}`]?.imagesConfirmed) || projectMapping(p).problems.length) return 'Confirm the images for every batch first.';
    if (stage === 'review') return null;
    return p.task.batchSynchronization === 'finished' && p.sync?.renderable ? null : 'Synchronisation must be complete and error-free before export.';
  };
  route('POST', '/api/projects/:id/stage', async ({ req, res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    const stage = (await readJson(req)).stage;
    if (!STAGES.includes(stage)) throw new AppError(400, 'INVALID_STAGE', 'Unknown stage.');
    const why = canEnter(p, stage); if (why) throw new AppError(409, 'STAGE_NOT_AVAILABLE', why);
    await db.updateProject(p.id, () => ({ stage }));
    if (stage === 'review' && p.task.audioTranscription === 'finished' && !['pending', 'finished'].includes(p.task.batchSynchronization)) await jobs.start(auth.userId, p.id, 'batchSynchronization').catch(() => {});
    await sendView(res, auth.userId, p.id);
  });

  // ---------- Stage 4: synchronisation ----------
  route('POST', '/api/projects/:id/sync', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    if (p.task.audioTranscription !== 'finished') throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'The transcript is not ready yet.');
    if (canEnter(p, 'review')) throw new AppError(409, 'IMAGES_NOT_CONFIRMED', 'Confirm the images for every batch first.');
    notPending(p, 'videoRendering');
    await jobs.start(auth.userId, p.id, 'batchSynchronization', { patch: { sync: null } });
    await sendView(res, auth.userId, p.id, 202);
  });
  route('GET', '/api/projects/:id/sync-status', async ({ res, auth, params }) => { const v = projectView(await getProject(auth.userId, params.id), cfg, now()); sendJson(res, 200, { task: v.task.batchSynchronization, meta: v.taskMeta.batchSynchronization, sync: v.sync }); });
  // User confirms an ambiguous match; saved persistently, then synchronisation is recomputed (fast, pure).
  route('POST', '/api/projects/:id/sync/resolve', async ({ req, res, auth, params }) => {
    const p = await getProject(auth.userId, params.id); notPending(p, 'batchSynchronization', 'videoRendering');
    const { kind, id, wordIndex } = await readJson(req);
    if (!['batch', 'image'].includes(kind) || !Number.isInteger(wordIndex) || (typeof id !== 'string' && typeof id !== 'number')) throw new AppError(400, 'INVALID_RESOLUTION', 'Invalid resolution request.');
    const item = p.sync?.unresolved?.find((u) => u.kind === kind && String(u.id) === String(id));
    if (!item || !item.candidates.some((c) => c.wordIndex === wordIndex)) throw new AppError(409, 'NOT_A_CANDIDATE', 'That choice is not one of the offered candidates.');
    const key = kind === 'batch' ? `batch_${id}` : `image_${id}`;
    const withOverride = { ...p, overrides: { ...p.overrides, [key]: { wordIndex } } };
    const sync = await computeProjectSync({ storage, project: withOverride, cfg, now });
    await db.updateProject(p.id, () => ({ [`overrides.${key}`]: { wordIndex }, sync, 'task.batchSynchronization': 'finished', render: null, 'task.videoRendering': null }));
    await sendView(res, auth.userId, p.id);
  });

  // ---------- Stage 5: render + download ----------
  route('POST', '/api/projects/:id/render', async ({ res, auth, params }) => {
    const p = await getProject(auth.userId, params.id);
    if (!(p.task.batchSynchronization === 'finished' && p.sync?.renderable)) throw new AppError(409, 'SYNC_NOT_RENDERABLE', 'Synchronisation must be complete and error-free before rendering.');
    await jobs.start(auth.userId, p.id, 'videoRendering', { guard: (c) => { if (!c.sync?.renderable) throw new AppError(409, 'SYNC_NOT_RENDERABLE', 'Synchronisation is not renderable.'); }, patch: { stage: 'export', render: null } });
    await sendView(res, auth.userId, p.id, 202);
  });
  route('GET', '/api/projects/:id/render-status', async ({ res, auth, params }) => { const v = projectView(await getProject(auth.userId, params.id), cfg, now()); sendJson(res, 200, { task: v.task.videoRendering, meta: v.taskMeta.videoRendering, render: v.render }); });
  route('GET', '/api/projects/:id/download', async ({ res, auth, params, query }) => {
    const p = await getProject(auth.userId, params.id);
    if (p.task.videoRendering !== 'finished' || !p.render?.key) throw new AppError(409, 'VIDEO_NOT_READY', 'The video is not ready yet.');
    await sendFile(res, query, { key: p.render.key, type: 'video/mp4', filename: 'video.mp4' });
  });
  // ---------- Videos library: every finished render, kept for VIDEO_RETENTION_DAYS, independent of projects ----------
  const videoView = (v) => ({ id: v.id, title: v.title, createdAt: v.createdAt, expiresAt: v.expiresAt, size: v.size, durationSeconds: v.durationSeconds, width: v.width, height: v.height, fps: v.fps });
  const ownVideo = async (userId, id) => { const v = await db.getVideo(id); if (!v || v.userId !== userId || v.expiresAt <= now()) throw new AppError(404, 'VIDEO_NOT_FOUND', 'Video not found (it may have expired).'); return v; };
  route('GET', '/api/videos', async ({ res, auth }) => {
    const t = now();
    sendJson(res, 200, { retentionDays: Math.round(cfg.videos.retentionMs / 86_400_000), videos: (await db.listVideosByUser(auth.userId)).filter((v) => v.expiresAt > t).sort((a, b) => b.createdAt - a.createdAt).map(videoView) });
  });
  route('GET', '/api/videos/:id/download', async ({ res, auth, params, query }) => {
    const v = await ownVideo(auth.userId, params.id);
    await sendFile(res, query, { key: v.key, type: 'video/mp4', filename: `${safeFilename(v.title, 'video')}_${new Date(v.createdAt).toISOString().slice(0, 10)}.mp4` });
  });
  route('DELETE', '/api/videos/:id', async ({ res, auth, params }) => {
    const v = await ownVideo(auth.userId, params.id);
    await storage.delete(v.key); await db.deleteVideo(v.id);
    sendJson(res, 200, { deleted: true });
  });
  route('POST', '/api/internal/cleanup', async ({ req, res }) => {
    if (!cfg.cronSecret || req.headers['x-cron-secret'] !== cfg.cronSecret) throw new AppError(403, 'FORBIDDEN', 'Forbidden.');
    sendJson(res, 200, await cleanupExpired({ db, storage, jobs, now, log }));
  }, { auth: false });

  // ---------- server ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      if (!general.allow(ip)) throw new AppError(429, 'RATE_LIMITED', 'Too many requests.');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && await serveIndex(res, cfg.publicDir, BUILD)) return;
        if (req.method === 'GET' && !url.pathname.startsWith('/api/') && await serveStatic(res, cfg.publicDir, url.pathname)) return;
        throw new AppError(404, 'NOT_FOUND', 'Not found.');
      }
      const params = r.re.exec(url.pathname).groups || {};
      const auth = r.auth ? await authUser(req) : null;
      await r.handler({ req, res, params, query: url.searchParams, auth, ip });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof AppError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
      log.error?.(JSON.stringify({ evt: 'request_error', path: url.pathname, message: String(e?.message).slice(0, 300) }));
      sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
    }
  });
  server.requestTimeout = 0; // large uploads; bounded by size caps and slot limits
  return { server, jobs, cleanup: () => cleanupExpired({ db, storage, jobs, now, log }) };
}
