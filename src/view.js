import { isDoneEnabled } from './domain/duration.js';
import { TASKS } from './domain/taskState.js';
import { orderedBatches, projectMapping } from './services/sync.js';
import { batchAudioSegments } from './domain/batchAudio.js';

/** Client-safe projection: never exposes R2 keys, credentials or filesystem paths. */
export function projectView(p, cfg, now) {
  const taskMeta = {};
  for (const t of TASKS) { const m = p.taskMeta?.[t] || {}; taskMeta[t] = { jobStatus: m.jobStatus ?? null, phase: m.phase ?? null, error: m.error ?? null, attempt: m.attempt ?? null, startedAt: m.startedAt ?? null, completedAt: m.completedAt ?? null, lastActivityAt: m.lastActivityAt ?? null, progress: m.progress ?? null }; }
  const mapping = projectMapping(p);
  return {
    id: p.id, stage: p.stage, state: p.state, serverNow: now, expiresAt: p.expiresAt,
    limits: { maxAudioSeconds: cfg.limits.maxAudioSeconds, returnWindowMinutes: Math.round(cfg.limits.returnWindowMs / 60000) },
    task: p.task, taskMeta,
    audio: p.audio ? { filename: p.audio.filename, size: p.audio.size, uploadedAt: p.audio.uploadedAt } : null,
    duration: p.duration || null,
    doneEnabled: isDoneEnabled(p, cfg.limits.maxAudioSeconds),
    transcript: p.transcript ? { wordCount: p.transcript.wordCount, model: p.transcript.model, createdAt: p.transcript.createdAt } : null,
    batchOrder: p.batchOrder,
    batches: orderedBatches(p).map((b) => ({ number: b.number, filename: b.filename, size: b.size, wordCount: b.wordCount, markers: b.markers, endPhrase: b.endPhrase, imagesConfirmed: !!b.imagesConfirmed })),
    images: Object.values(p.images || {}).map((i) => ({ id: i.id, tag: i.tag, batch: i.batch, marker: i.marker, filename: i.filename, size: i.size })),
    mappingProblems: mapping.problems,
    sync: p.sync || null,
    batchAudio: batchAudioSegments(p),
    batchAudioFormat: cfg.batchAudioFormat,
    render: p.render ? { outputId: p.render.outputId, createdAt: p.render.createdAt, size: p.render.size, width: p.render.width, height: p.render.height, fps: p.render.fps, outputDurationSeconds: p.render.outputDurationSeconds, authoritativeDurationSeconds: p.render.authoritativeDurationSeconds, warnings: p.render.warnings } : null,
  };
}
