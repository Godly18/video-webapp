/**
 * Per-batch audio segments from the synchronisation result.
 * Batch k covers [end of batch k-1, end of batch k] where "end" is the END timestamp of the batch's final word, so the segments touch exactly:
 * joined together they reproduce the whole narration with nothing lost or repeated. The first batch starts at 0 and the LAST batch runs to the
 * authoritative audio duration (so trailing silence/music is kept). Stops at the first batch whose end is not resolved yet.
 */
export function batchAudioSegments(project) {
  const sync = project?.sync, duration = project?.duration?.seconds;
  if (project?.task?.batchSynchronization !== 'finished' || !sync?.batches?.length || !Number.isFinite(duration)) return [];
  const out = []; let prev = 0;
  sync.batches.forEach((b, i) => {
    if (out.length !== i || !Number.isFinite(b.endSeconds)) return;              // an unresolved batch blocks everything after it
    const end = i === sync.batches.length - 1 ? duration : b.endSeconds;
    if (!(end > prev)) return;                                                   // impossible interval (e.g. wrong batch order): not offered
    out.push({ number: b.number, startSeconds: prev, endSeconds: end });
    prev = b.endSeconds;
  });
  return out;
}
export const AUDIO_FORMATS = { mp3: { ext: 'mp3', type: 'audio/mpeg' }, wav: { ext: 'wav', type: 'audio/wav' }, m4a: { ext: 'm4a', type: 'audio/mp4' } };
