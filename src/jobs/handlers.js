import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { determineDuration, buildDurationRecord } from '../domain/duration.js';
import { buildRenderPlan } from '../domain/timeline.js';
import { computeProjectSync, projectMapping } from '../services/sync.js';
import { nextFps } from '../domain/renderPlanner.js';

export async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'svg-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
const storageErr = (e) => (e instanceof AppError ? e : new AppError(503, 'STORAGE_ERROR', 'Cloud storage is temporarily unavailable.', { retryable: true }));
const download = async (storage, key, dest) => { try { await storage.downloadTo(key, dest); } catch (e) { throw storageErr(e); } };
const projectKeyPrefix = (p) => `users/${p.userId}/projects/${p.id}/`;

export function registerHandlers({ jobs, db, storage, ff, gemini, cfg, now = Date.now }) {
  jobs.register('audioDuration', async ({ job, progress, signal }) => {
    const p = await db.getProject(job.projectId);
    if (!p?.audio?.key) throw new AppError(422, 'AUDIO_MISSING', 'No audio has been uploaded.');
    await withTmp(async (dir) => {
      const file = path.join(dir, 'audio');
      await download(storage, p.audio.key, file);
      const res = await determineDuration({
        probe: () => ff.probeDuration(file),
        playback: (max) => ff.measurePlayback(file, { maxSeconds: max, signal, onProgress: (s) => { progress.playedSeconds = s; } }),
        maxSeconds: cfg.limits.maxAudioSeconds, graceSeconds: cfg.ffmpeg.playbackGraceSeconds,
        onFallback: (reason) => jobs.patchMeta(job, { phase: 'playback_fallback', fallbackReason: reason, fallbackStartedAt: now() }),
      });
      await jobs.finish(job, { duration: buildDurationRecord(res, cfg.limits.maxAudioSeconds, now()) });
    });
  });

  jobs.register('audioTranscription', async ({ job, signal }) => {
    const p = await db.getProject(job.projectId);
    if (!p?.audio?.key || !p.duration) throw new AppError(409, 'AUDIO_NOT_READY', 'Audio and duration must be available first.');
    const t = await withTmp(async (dir) => {
      const file = path.join(dir, 'audio');
      await download(storage, p.audio.key, file);
      // Send a WAV with an exact length (see ff.transcodeForTranscription); the ORIGINAL upload stays untouched in R2 and is what the video uses.
      const wav = path.join(dir, 'transcribe.wav');
      try { await ff.transcodeForTranscription(file, wav, { signal }); }
      catch (e) { throw new AppError(422, e.code === 'TRANSCODE_TIMEOUT' ? 'AUDIO_PREP_TIMEOUT' : 'AUDIO_PREP_FAILED', 'The audio could not be prepared for transcription.'); }
      const chk = await ff.probeDuration(wav);
      const tol = Math.max(2, p.duration.seconds * 0.01);
      if (!chk.ok || Math.abs(chk.seconds - p.duration.seconds) > tol) throw new AppError(422, 'AUDIO_DURATION_MISMATCH', `The audio decoded to ${chk.ok ? chk.seconds.toFixed(1) + 's' : 'an unreadable file'} but was measured as ${p.duration.seconds.toFixed(1)}s, so it can't be transcribed reliably. Try a different audio file (e.g. MP3, M4A or WAV).`);
      return gemini.transcribe({ filePath: wav, filename: 'transcribe.wav', durationSeconds: p.duration.seconds, signal });
    });
    const key = `${projectKeyPrefix(p)}transcript/${newId('tr')}.json`;
    try { await storage.putBuffer(key, Buffer.from(JSON.stringify({ text: t.text, words: t.words, model: t.model }), 'utf8'), { contentType: 'application/json' }); } catch (e) { throw storageErr(e); }
    await jobs.finish(job, { transcript: { key, wordCount: t.words.length, model: t.model, createdAt: now() } });
    if (p.transcript?.key) storage.delete(p.transcript.key).catch(() => {});
  });

  jobs.register('batchSynchronization', async ({ job }) => {
    const p = await db.getProject(job.projectId);
    const sync = await computeProjectSync({ storage, project: p, cfg, now });
    await jobs.finish(job, { sync });
  });

  // Progress/phase are written straight to the task record (not only on the 20 s heartbeat) so the UI sees them within seconds.
  const quietMeta = (job, fields) => jobs.patchMeta(job, { ...fields, lastActivityAt: now() }).catch(() => {});
  jobs.register('videoRendering', async ({ job, signal, progress }) => {
    const p = await db.getProject(job.projectId);
    if (!p?.sync?.renderable) throw new AppError(409, 'SYNC_NOT_RENDERABLE', 'Synchronisation must be complete and valid before rendering.');
    const idByTag = Object.fromEntries(projectMapping(p).mappings.map((m) => [m.tag, m.imageId]));
    let plan;
    try { plan = buildRenderPlan(p.sync, idByTag, p.duration.seconds); } catch (e) { throw new AppError(422, 'RENDER_PLAN_INVALID', e.message); }
    const outputId = newId('out');
    const warnings = []; let renderedFps = cfg.render.fps;
    const outKey = `${projectKeyPrefix(p)}outputs/${outputId}.mp4`;
    const meta = await withTmp(async (dir) => {
      await quietMeta(job, { phase: 'preparing', progress: { renderedSeconds: 0, totalSeconds: p.duration.seconds, fps: cfg.render.fps } });
      const audioPath = path.join(dir, 'audio');
      await download(storage, p.audio.key, audioPath);
      const files = {};
      for (const s of plan) {
        if (files[s.imageId]) continue;
        const img = p.images[s.imageId];
        files[s.imageId] = path.join(dir, `${s.imageId}.${img.ext}`);
        await download(storage, img.key, files[s.imageId]);
      }
      const outPath = path.join(dir, 'out.mp4');
      // Time budget: if the render is projected to overrun, restart once per step at a lower frame rate (stills look identical).
      const total = p.duration.seconds, budget = cfg.render.budgetMs, t0 = now();
      let fps = cfg.render.fps, lastWrite = 0;
      await quietMeta(job, { phase: 'encoding', progress: { renderedSeconds: 0, totalSeconds: total, fps } });
      const segments = plan.map((s) => ({ file: files[s.imageId], from: s.from, to: s.to }));
      for (;;) {
        const used = now() - t0;
        const canStepDown = nextFps({ currentFps: fps, projectedMs: 1, remainingMs: 1, configuredFps: cfg.render.fps }) !== null; // at the lowest rate there is nothing cheaper to try
        try {
          await ff.renderVideo({ segments, audioPath, outPath, workDir: dir, signal, fps, totalSeconds: total, budgetMs: canStepDown ? Math.max(budget - used, 60_000) : 0, timeoutMs: Math.max(cfg.render.timeoutMs - used, 60_000),
            onProgress: (pr) => {
              progress.renderedSeconds = +pr.renderedSeconds.toFixed(1); progress.totalSeconds = total; progress.fps = pr.fps;
              if (now() - lastWrite >= 2000) { lastWrite = now(); quietMeta(job, { phase: 'encoding', progress: { ...progress } }); }
            } });
          break;
        } catch (e) {
          if (e.code === 'RENDER_TOO_SLOW') {
            const lower = nextFps({ currentFps: fps, projectedMs: e.projectedMs, remainingMs: Math.max(budget - (now() - t0), 60_000), configuredFps: cfg.render.fps });
            if (lower) { warnings.push(`This server is slow, so the video was rendered at ${lower} fps instead of ${cfg.render.fps} fps to finish in time. Still images look the same.`); fps = lower; progress.renderedSeconds = 0; lastWrite = 0; await quietMeta(job, { phase: 'encoding', progress: { renderedSeconds: 0, totalSeconds: total, fps } }); continue; }
          }
          throw e.code === 'RENDER_TIMEOUT' ? new AppError(504, 'RENDER_TIMEOUT', 'Rendering took too long and was stopped.') : new AppError(500, e.code || 'RENDER_FAILED', 'Rendering failed.');
        }
      }
      renderedFps = fps;
      const info = await ff.inspect(outPath); // diagnostics only: never overrides the authoritative duration
      const v = info.streams.find((s) => s.codec_type === 'video'), a = info.streams.find((s) => s.codec_type === 'audio');
      if (!v || v.codec_name !== 'h264' || !a || a.codec_name !== 'aac') throw new AppError(500, 'RENDER_OUTPUT_INVALID', 'The rendered file is missing H.264 video or AAC audio.');
      await quietMeta(job, { phase: 'uploading', progress: { renderedSeconds: total, totalSeconds: total, fps } });
      try { await storage.putFile(outKey, outPath, { contentType: 'video/mp4' }); } catch (e) { throw storageErr(e); }
      if (!(await storage.exists(outKey))) throw new AppError(503, 'STORAGE_ERROR', 'The rendered file could not be confirmed in storage.', { retryable: true });
      return { outputDurationSeconds: info.duration, width: v.width, height: v.height, size: (await stat(outPath)).size };
    });
    if (Math.abs(meta.outputDurationSeconds - p.duration.seconds) > 1) warnings.push(`Output duration ${meta.outputDurationSeconds.toFixed(2)}s differs from the authoritative ${p.duration.seconds.toFixed(2)}s.`);
    await jobs.finish(job, { render: { key: outKey, outputId, createdAt: now(), ...meta, authoritativeDurationSeconds: p.duration.seconds, fps: renderedFps, warnings } });
    if (p.render?.key && p.render.key !== outKey) storage.delete(p.render.key).catch(() => {});
  });
}
