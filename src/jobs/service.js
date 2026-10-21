import { AppError, StaleAttemptError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nextExpiry } from '../domain/taskState.js';

/**
 * In-process background jobs for a single Render web service (no separate worker).
 *
 * Durability model (honest version): the QUEUE and RUNNING STATE live only in this process, but every job and every
 * task status is persisted in Firestore. If the process restarts, jobs whose heartbeat went stale are detected by
 * recover() and either retried safely from their stored R2 inputs (attempt+1) or marked interrupted. Commits are fenced by
 * (jobId, attempt) so a superseded attempt can never overwrite a newer result or mark a task finished.
 */
export class JobService {
  constructor({ db, cfg, now = Date.now, log = console, instanceId = newId('inst'), remote = null }) {
    Object.assign(this, { db, cfg, now, log, instanceId, remote });
    this.handlers = {};
    this.known = new Set();          // job ids this process is queued/running/retrying
    this.running = new Map();        // jobId -> {type, controller}
    this.queue = [];                 // [{id, type}]
    this.timers = new Set();
    this.shuttingDown = false;
  }
  register(type, fn) { this.handlers[type] = fn; }
  /** Liveness of a job = newest of this server's heartbeat and the remote runner's heartbeat. */
  _live(j) { return Math.max(j.heartbeatAt ?? 0, j.remoteHeartbeatAt ?? 0); }
  _windowMs() { return this.cfg.limits.returnWindowMs; }
  _fence(p, job) { const m = p.taskMeta?.[job.type]; return !!m && m.jobId === job.id && m.attempt === job.attempt && p.task?.[job.type] === 'pending'; }

  /** Start a task unless one is already pending. guard(project) may throw AppError to reject inside the same atomic update. */
  async start(userId, projectId, type, { patch = {}, guard } = {}) {
    const now = this.now();
    const jobId = newId(type.toLowerCase());
    await this.db.createJob({ id: jobId, userId, projectId, type, status: 'queued', attempt: 1, createdAt: now, heartbeatAt: now, error: null, progress: null });
    let outcome;
    try {
      await this.db.updateProject(projectId, (p) => {
        if (p.userId !== userId) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
        if (p.task[type] === 'pending') { outcome = { started: false, jobId: p.taskMeta[type]?.jobId }; return null; }
        guard?.(p);
        outcome = { started: true, jobId };
        return {
          ...patch,
          [`task.${type}`]: 'pending',
          [`taskMeta.${type}`]: { jobId, attempt: 1, jobStatus: 'queued', startedAt: now, lastActivityAt: now, completedAt: null, error: null },
          lastActivityAt: now, expiresAt: nextExpiry(p.expiresAt, now, this._windowMs()),
        };
      });
    } catch (e) { await this._cancel(jobId); throw e; }
    if (!outcome.started) { await this._cancel(jobId); return outcome; }
    this._enqueue(jobId, type);
    return outcome;
  }
  async _cancel(jobId) { await this.db.updateJob(jobId, () => ({ status: 'cancelled', finishedAt: this.now() })).catch(() => {}); }

  _enqueue(id, type) { this.known.add(id); this.queue.push({ id, type }); setImmediate(() => this._pump()); }
  _pump() {
    if (this.shuttingDown) return;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      const limit = this.cfg.jobs.concurrency[item.type] ?? 1;
      const inLane = [...this.running.values()].filter((r) => r.type === item.type).length;
      if (inLane >= limit) continue;
      this.queue.splice(i, 1); i--;
      this.running.set(item.id, { type: item.type, controller: new AbortController() });
      this._run(item.id, item.type).catch((e) => this.log.error?.('job runner error', e)).finally(() => { this.running.delete(item.id); this.known.delete(item.id); this._pump(); });
    }
  }

  async _run(jobId, type) {
    const now = this.now();
    let job = await this.db.getJob(jobId);
    if (!job || job.status !== 'queued') return;
    job = await this.db.updateJob(jobId, (j) => (j.status === 'queued' ? { status: 'running', ownerInstance: this.instanceId, startedAt: now, heartbeatAt: now } : null));
    if (job.status !== 'running' || job.ownerInstance !== this.instanceId) return;
    const { controller } = this.running.get(jobId);
    const progress = {};
    await this.patchMeta(job, { jobStatus: 'running', lastActivityAt: now }).catch(() => {});
    const timer = setInterval(() => this._heartbeat(job, progress), this.cfg.jobs.heartbeatMs); timer.unref?.();
    try {
      const handler = this.handlers[type];
      if (!handler) throw new AppError(500, 'NO_HANDLER', `No handler for ${type}`);
      let where = 'local';
      if (this.remote?.types.has(type)) where = await this._runRemote(job, controller.signal); // 'done' | 'local' | 'aborted'
      if (where === 'aborted') return;
      if (where === 'local') await handler({ job, progress, signal: controller.signal });
      await this.db.updateJob(jobId, (j) => (j.attempt === job.attempt && j.status === 'running' ? { status: 'succeeded', finishedAt: this.now() } : null));
    } catch (e) {
      if (e instanceof StaleAttemptError) { await this._cancel(jobId); return; }
      if (this.shuttingDown) return; // left 'running'; recover() on next boot treats it as interrupted
      const retry = e?.retryable && job.attempt < this.cfg.jobs.maxAttempts;
      this.log.error?.(JSON.stringify({ evt: 'job_error', jobId, type, attempt: job.attempt, code: e?.code, message: String(e?.message).slice(0, 300), retry }));
      if (retry) await this._retry(job, e); else await this.fail(job, e);
    } finally { clearInterval(timer); }
  }

  /** Move a job to its next attempt (project + job doc, fenced). keepRunner: the remote runner itself continues. Returns the new job doc or null. */
  async _bump(job, e, { keepRunner = false } = {}) {
    const next = job.attempt + 1, t = this.now();
    const won = await this.db.updateProject(job.projectId, (p) => (this._fence(p, job) ? { [`taskMeta.${job.type}.attempt`]: next, [`taskMeta.${job.type}.jobStatus`]: keepRunner ? 'running' : 'queued', [`taskMeta.${job.type}.error`]: { code: e.code || 'RETRYING', message: 'A temporary problem occurred; retrying.', retrying: true } } : null)).catch(() => null);
    if (!won || won.taskMeta?.[job.type]?.attempt !== next) return null;
    const reset = keepRunner ? {} : { executor: null, runnerRunId: null, dispatchedAt: null, remoteHeartbeatAt: null };
    const nj = await this.db.updateJob(job.id, (j) => (j.attempt === job.attempt ? { status: keepRunner ? 'running' : 'queued', attempt: next, heartbeatAt: t, lastError: { code: e.code, at: t }, ...reset } : null));
    return nj.attempt === next ? nj : null;
  }
  async _retry(job, e) {
    if (!(await this._bump(job, e))) return;
    this.known.add(job.id);
    const delay = Math.min(this.cfg.jobs.retryBaseMs * 2 ** (job.attempt - 1), 30_000);
    const timer = setTimeout(() => { this.timers.delete(timer); this._enqueue(job.id, job.type); }, delay); timer.unref?.(); this.timers.add(timer);
  }
  async _heartbeat(job, progress, { remote = false } = {}) {
    const t = this.now(), hasProgress = Object.keys(progress).length > 0;   // never overwrite progress written by the other side with an empty object
    await this.db.updateJob(job.id, (j) => (j.status === 'running' && j.attempt === job.attempt ? { heartbeatAt: t, ...(remote ? { remoteHeartbeatAt: t } : {}), ...(hasProgress ? { progress: { ...progress } } : {}) } : null)).catch(() => {});
    await this.db.updateProject(job.projectId, (p) => (this._fence(p, job) ? { [`taskMeta.${job.type}.lastActivityAt`]: t, ...(hasProgress ? { [`taskMeta.${job.type}.progress`]: { ...progress } } : {}), expiresAt: nextExpiry(p.expiresAt, t, this._windowMs()) } : null)).catch(() => {});
  }

  // ---------------- remote execution (GitHub Actions) ----------------
  _snapshot() { const r = this.cfg.render; return { render: { width: r.width, height: r.height, fps: r.fps, fit: r.fit, crf: r.crf, budgetMs: r.budgetMs }, limits: { maxAudioSeconds: this.cfg.limits.maxAudioSeconds } }; }
  async _localFallback(job, reason) {
    if (!this.remote.fallbackLocal) throw new AppError(503, reason, 'Could not start the render server. Please try again.', { retryable: true });
    const j = await this.db.updateJob(job.id, (cur) => (cur.attempt === job.attempt && !cur.runnerRunId ? { executor: 'local' } : null)); // only if no runner has claimed it
    return j.executor === 'local' ? 'local' : 'waiting';
  }
  /** Dispatch the job to a runner and wait for it. Returns 'done' (runner finished/failed it), 'local' (fell back), or 'aborted'. */
  async _runRemote(job, signal) {
    const R = this.remote, t0 = this.now();
    await this.db.updateJob(job.id, (j) => (j.attempt === job.attempt ? { executor: 'github', dispatchedAt: t0, runnerRunId: null, remoteHeartbeatAt: null, cfgSnapshot: this._snapshot() } : null));
    await this.patchMeta(job, { phase: 'starting', progress: null }).catch(() => {});
    try { await R.dispatch({ jobId: job.id, type: job.type }); }
    catch (e) { this.log.error?.(JSON.stringify({ evt: 'dispatch_failed', jobId: job.id, message: String(e?.message).slice(0, 200) })); if ((await this._localFallback(job, 'DISPATCH_FAILED')) === 'local') return 'local'; }
    const hardLimit = t0 + this.cfg.render.timeoutMs + 10 * 60_000;
    const sleep = (ms) => new Promise((r) => { const tm = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(tm); r(); }, { once: true }); });
    for (;;) {
      await sleep(R.pollMs);
      if (signal?.aborted) return 'aborted';
      const j = await this.db.getJob(job.id), t = this.now();
      if (!j || j.attempt !== job.attempt || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.status)) return 'done';
      if (!j.runnerRunId) {
        if (t - j.dispatchedAt > R.startTimeoutMs && (await this._localFallback(job, 'RUNNER_NOT_STARTED')) === 'local') return 'local';
      } else if (t - (j.remoteHeartbeatAt ?? j.runnerStartedAt ?? 0) > R.staleMs) {
        throw new AppError(503, 'REMOTE_RUNNER_LOST', 'The render server stopped responding.', { retryable: true });
      }
      if (t > hardLimit) throw new AppError(504, 'REMOTE_TIMEOUT', 'The render server took too long.');
    }
  }
  /** Entry point for the GitHub Actions runner (src/remoteRunner.js): claim the dispatched job, run the SAME handler, record the outcome. Returns a process exit code. */
  async runAsRunner(jobId, runId) {
    const t0 = this.now();
    if (!(await this.db.getJob(jobId))) { this.log.error?.('job not found ' + jobId); return 1; }
    let job = await this.db.updateJob(jobId, (j) => (j.status === 'running' && j.executor === 'github' && !j.runnerRunId ? { runnerRunId: String(runId), runnerStartedAt: t0, remoteHeartbeatAt: t0 } : null));
    if (job.runnerRunId !== String(runId)) { this.log.info?.(`job ${jobId} is not claimable by run ${runId} (already claimed, finished or run locally)`); return 0; }
    const handler = this.handlers[job.type], progress = {}, controller = new AbortController();
    await this.patchMeta(job, { phase: 'preparing' }).catch(() => {});   // the user sees "render server started" at once
    const timer = setInterval(() => this._heartbeat(job, progress, { remote: true }), this.cfg.jobs.heartbeatMs); timer.unref?.();
    try {
      for (;;) {
        try {
          await handler({ job, progress, signal: controller.signal });
          await this.db.updateJob(jobId, (j) => (j.attempt === job.attempt && j.status === 'running' ? { status: 'succeeded', finishedAt: this.now() } : null));
          return 0;
        } catch (e) {
          if (e instanceof StaleAttemptError) return 0;                       // superseded by a newer attempt: leave its records alone
          const retry = e?.retryable && job.attempt < this.cfg.jobs.maxAttempts;
          this.log.error?.(JSON.stringify({ evt: 'job_error', jobId, type: job.type, attempt: job.attempt, code: e?.code, message: String(e?.message).slice(0, 300), retry, runner: true }));
          const next = retry ? await this._bump(job, e, { keepRunner: true }) : null;
          if (!next) { await this.fail(job, e); return 1; }
          job = next; await new Promise((r) => setTimeout(r, Math.min(this.cfg.jobs.retryBaseMs, 5000)));
        }
      }
    } finally { clearInterval(timer); }
  }

  /** Apply fenced metadata to taskMeta.<type>. Never throws on a lost fence. */
  async patchMeta(job, fields) {
    await this.db.updateProject(job.projectId, (p) => (this._fence(p, job) ? Object.fromEntries(Object.entries(fields).map(([k, v]) => [`taskMeta.${job.type}.${k}`, v])) : null));
  }

  /** Mark finished ONLY after the caller has persisted its result (R2 object, transcript, ...). Fenced; throws StaleAttemptError if superseded. */
  async finish(job, resultPatch = {}) {
    const t = this.now();
    await this.db.updateProject(job.projectId, (p) => {
      if (!this._fence(p, job)) throw new StaleAttemptError();
      return {
        ...resultPatch,
        [`task.${job.type}`]: 'finished',
        [`taskMeta.${job.type}.completedAt`]: t, [`taskMeta.${job.type}.lastActivityAt`]: t,
        [`taskMeta.${job.type}.jobStatus`]: 'succeeded', [`taskMeta.${job.type}.error`]: null, [`taskMeta.${job.type}.phase`]: null,
        lastActivityAt: t, expiresAt: nextExpiry(p.expiresAt, t, this._windowMs()), // result is kept for a full window after completion
      };
    });
  }
  /** Failed/interrupted tasks go back to null (never 'finished'); the reason lives in taskMeta + the job doc. */
  async fail(job, error, { interrupted = false } = {}) {
    const t = this.now();
    const err = { code: error?.code || 'JOB_FAILED', message: error instanceof AppError ? error.message : 'The task failed unexpectedly. Please try again.', at: t };
    const status = interrupted ? 'interrupted' : 'failed';
    await this.db.updateProject(job.projectId, (p) => (this._fence(p, job)
      ? { [`task.${job.type}`]: null, [`taskMeta.${job.type}.jobStatus`]: status, [`taskMeta.${job.type}.error`]: err, [`taskMeta.${job.type}.completedAt`]: null, [`taskMeta.${job.type}.phase`]: null, lastActivityAt: t, expiresAt: nextExpiry(p.expiresAt, t, this._windowMs()) }
      : null)).catch(() => {});
    await this.db.updateJob(job.id, (j) => (j.attempt === job.attempt ? { status, error: err, finishedAt: t } : null)).catch(() => {});
  }

  /** Detect jobs left behind by a restart/deploy and retry or fail them. Safe to call repeatedly and from several instances. */
  async recover() {
    const t = this.now(), out = { retried: 0, failed: 0, cancelled: 0 };
    for (const j of await this.db.listJobsByStatus(['queued', 'running'])) {
      if (this.known.has(j.id) || t - this._live(j) <= this.cfg.jobs.staleMs) continue;
      const p = await this.db.getProject(j.projectId);
      if (!p || p.state !== 'active' || !this._fence(p, j)) { await this._cancel(j.id); out.cancelled++; continue; }
      if (j.attempt < this.cfg.jobs.maxAttempts) {
        const next = j.attempt + 1;
        const claimed = await this.db.updateJob(j.id, (cur) => (cur.attempt === j.attempt && ['queued', 'running'].includes(cur.status) && t - this._live(cur) > this.cfg.jobs.staleMs
          ? { status: 'queued', attempt: next, heartbeatAt: t, interruptions: (cur.interruptions || 0) + 1, executor: null, runnerRunId: null, dispatchedAt: null, remoteHeartbeatAt: null } : null));
        if (claimed.attempt !== next) continue;
        await this.db.updateProject(j.projectId, (cur) => (this._fence(cur, j) ? { [`taskMeta.${j.type}.attempt`]: next, [`taskMeta.${j.type}.jobStatus`]: 'queued', [`taskMeta.${j.type}.error`]: { code: 'INTERRUPTED', message: 'Processing was interrupted by a server restart and has been restarted.', retrying: true } } : null)).catch(() => {});
        this._enqueue(j.id, j.type); out.retried++;
      } else {
        await this.fail(j, new AppError(503, 'INTERRUPTED', 'Processing was interrupted by a server restart. Please retry.'), { interrupted: true }); out.failed++;
      }
    }
    return out;
  }
  startRecoveryLoop() { this.recoverTimer = setInterval(() => this.recover().catch((e) => this.log.error?.('recover failed', e)), Math.max(10_000, this.cfg.jobs.staleMs / 3)); this.recoverTimer.unref?.(); }
  async activeJobsFor(projectId) {
    const t = this.now();
    return (await this.db.listJobsByStatus(['queued', 'running'])).filter((j) => j.projectId === projectId && (this.known.has(j.id) || t - this._live(j) <= this.cfg.jobs.staleMs));
  }
  async shutdown() {
    this.shuttingDown = true; clearInterval(this.recoverTimer);
    this.timers.forEach(clearTimeout);
    for (const [id, r] of this.running) { r.controller.abort(); await this.db.updateJob(id, () => ({ heartbeatAt: 0 })).catch(() => {}); } // stale immediately -> next boot recovers it
  }
}
