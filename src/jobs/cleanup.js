/**
 * Expiry cleanup. Idempotent and safe to run from a timer AND from an external cron hitting /api/internal/cleanup.
 * Skips any project with a live (non-stale) job so inputs are never deleted under a running task; it is retried next sweep.
 * Cleaned project records are kept (files gone, expiresAt cleared) for diagnostics, so "deleted file" is never confused with "pending job".
 */
export async function cleanupExpired({ db, storage, jobs, now = Date.now, log = console }) {
  const t = now();
  const out = { cleaned: 0, skippedActive: 0, failed: 0, videosDeleted: 0 };
  for (const p of await db.listProjectsExpiredBefore(t)) {
    if (p.state === 'cleaned') continue;
    if ((await jobs.activeJobsFor(p.id)).length) { out.skippedActive++; continue; }
    try {
      if (p.state === 'active') await db.updateProject(p.id, (cur) => (cur.state === 'active' ? { state: 'expired', expiredAt: t } : null));
      await storage.deletePrefix(`users/${p.userId}/projects/${p.id}/`);
      await db.updateProject(p.id, () => ({ state: 'cleaned', cleanedAt: t, expiresAt: null, cleanupError: null }));
      const u = await db.getUser(p.userId);
      if (u?.activeProjectId === p.id) await db.upsertUser(p.userId, { activeProjectId: null });
      out.cleaned++;
    } catch (e) {
      out.failed++;
      log.error?.(JSON.stringify({ evt: 'cleanup_failed', projectId: p.id, message: String(e?.message).slice(0, 200) }));
      await db.updateProject(p.id, (cur) => ({ cleanupError: { at: t, message: 'cleanup will be retried' }, cleanupAttempts: (cur.cleanupAttempts || 0) + 1 })).catch(() => {});
    }
  }
  // Video library retention (independent of projects): delete the file first, then the record; failures are retried next sweep.
  for (const v of await db.listVideosExpiredBefore(t)) {
    try { await storage.delete(v.key); await db.deleteVideo(v.id); out.videosDeleted++; }
    catch (e) { out.failed++; log.error?.(JSON.stringify({ evt: 'video_cleanup_failed', videoId: v.id, message: String(e?.message).slice(0, 200) })); }
  }
  return out;
}
