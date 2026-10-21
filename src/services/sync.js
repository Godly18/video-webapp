import { computeSync } from '../domain/timeline.js';
import { buildMapping } from '../domain/imageMapping.js';
import { AppError } from '../lib/errors.js';

export const orderedBatches = (p) => p.batchOrder.map((n) => p.batches[`b${n}`]).filter(Boolean);
export const projectMapping = (p) => buildMapping({
  batches: orderedBatches(p).map((b) => ({ number: b.number, markers: b.markers })),
  images: Object.values(p.images || {}).map((i) => ({ id: i.id, tag: i.tag })),
});

/** Loads the transcript + batch documents from R2 and runs the pure synchronisation. */
export async function computeProjectSync({ storage, project, cfg, now }) {
  if (!project.transcript?.key) throw new AppError(409, 'TRANSCRIPT_NOT_READY', 'The transcript is not ready yet.');
  if (!project.duration || project.duration.exact === false) throw new AppError(409, 'DURATION_NOT_READY', 'The audio duration is not available.');
  const { problems } = projectMapping(project);
  if (problems.length) throw new AppError(422, 'MAPPING_INVALID', problems[0].message, { details: problems });
  const transcript = JSON.parse((await storage.getBuffer(project.transcript.key)).toString('utf8'));
  const batches = [];
  for (const b of orderedBatches(project)) batches.push({ number: b.number, text: (await storage.getBuffer(b.key)).toString('utf8') });
  const result = computeSync({ words: transcript.words, durationSeconds: project.duration.seconds, batches, overrides: project.overrides || {}, minIntervalSeconds: 1 / cfg.render.fps });
  return { ...result, computedAt: now() };
}
