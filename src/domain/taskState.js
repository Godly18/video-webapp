/** Firestore task vocabulary is exactly: 'pending' | 'finished' | null (real null). "done" is UI wording only. */
export const TASKS = ['audioDuration', 'audioTranscription', 'batchSynchronization', 'videoRendering'];
export const isValidStatus = (v) => v === null || v === 'pending' || v === 'finished';
export const initialTasks = () => Object.fromEntries(TASKS.map((t) => [t, null]));
export const initialTaskMeta = () => Object.fromEntries(TASKS.map((t) => [t, {}]));
export const STAGES = ['audio', 'batches', 'images', 'review', 'export'];

/** Expiry policy: expiresAt = (latest of last user activity, job heartbeat, task completion) + return window. Server clock only. */
export const nextExpiry = (currentExpiresAt, nowMs, windowMs) => Math.max(currentExpiresAt || 0, nowMs + windowMs);
export function isExpired(project, nowMs) {
  if (!project) return true;
  if (project.state !== 'active') return true;
  return nowMs > project.expiresAt;
}
export const anyPending = (project) => TASKS.some((t) => project.task?.[t] === 'pending');
