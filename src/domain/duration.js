import { displayDuration } from '../lib/time.js';
import { AppError } from '../lib/errors.js';

export const DURATION_SOURCES = ['ffprobe', 'playback_fallback'];
export const isValidDurationSeconds = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

/**
 * FFprobe first. The playback fallback runs ONLY when probe() reports it could not produce a valid duration.
 * A valid FFprobe result is never replaced. Permanent probe failures (e.g. no audio stream) do not trigger the fallback.
 */
export async function determineDuration({ probe, playback, maxSeconds, graceSeconds = 0, onFallback }) {
  const p = await probe();
  if (p && p.ok && isValidDurationSeconds(p.seconds)) return { seconds: p.seconds, source: 'ffprobe', exact: true, method: p.method, formatSeconds: p.formatSeconds };
  if (p && p.permanent) throw new AppError(422, p.reason || 'UNSUPPORTED_AUDIO', 'This file could not be read as audio.');
  if (onFallback) await onFallback(p?.reason || 'FFPROBE_NO_DURATION');
  const f = await playback(maxSeconds + graceSeconds);
  if (!f || !f.ok || !isValidDurationSeconds(f.seconds)) throw new AppError(422, 'DURATION_UNDETERMINED', 'Unable to determine the audio duration.');
  return { seconds: f.seconds, source: 'playback_fallback', exact: f.exact !== false };
}
/** Persisted duration record. Over-limit is strict: 1500 accepted, anything greater rejected. */
export function buildDurationRecord({ seconds, source, exact = true, method, formatSeconds }, maxSeconds, now) {
  return { seconds, source, exact, method: method ?? null, formatSeconds: formatSeconds ?? null, overLimit: seconds > maxSeconds, maxSeconds, display: displayDuration(seconds, maxSeconds), measuredAt: now };
}
/** Server-side gate for the UI's Done button (the frontend only mirrors this). */
export function isDoneEnabled(project, maxSeconds) {
  const d = project?.duration;
  return project?.task?.audioDuration === 'finished' && !!d && DURATION_SOURCES.includes(d.source) && d.exact !== false
    && isValidDurationSeconds(d.seconds) && d.seconds <= maxSeconds;
}
