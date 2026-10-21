import { applyPatch } from '../lib/patch.js';
import { AppError } from '../lib/errors.js';
const clone = (x) => structuredClone(x);

/** In-memory database for local development and tests ONLY (refused in production by config). Same interface as Firestore driver. */
export class MemoryDb {
  constructor() { this.users = new Map(); this.projects = new Map(); this.jobs = new Map(); }
  async getUser(id) { return clone(this.users.get(id) ?? null); }
  async upsertUser(id, fields, createFields = {}) {
    const cur = this.users.get(id);
    const next = cur ? { ...cur, ...fields } : { ...createFields, ...fields };
    this.users.set(id, next); return clone(next);
  }
  async getProject(id) { return clone(this.projects.get(id) ?? null); }
  async createProject(doc) { if (this.projects.has(doc.id)) throw new Error('exists'); this.projects.set(doc.id, clone(doc)); return clone(doc); }
  /** mutator(currentDoc) -> dotted patch | null. Runs atomically (Firestore: inside a transaction, so it may be re-invoked). */
  async updateProject(id, mutator) {
    const cur = this.projects.get(id);
    if (!cur) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found.');
    const patch = mutator(clone(cur));
    if (!patch) return clone(cur);
    const next = applyPatch(cur, patch); this.projects.set(id, next); return clone(next);
  }
  async listProjectsExpiredBefore(ms) { return [...this.projects.values()].filter((p) => typeof p.expiresAt === 'number' && p.expiresAt <= ms).map(clone); }
  async getJob(id) { return clone(this.jobs.get(id) ?? null); }
  async createJob(doc) { if (this.jobs.has(doc.id)) throw new Error('exists'); this.jobs.set(doc.id, clone(doc)); return clone(doc); }
  async updateJob(id, mutator) {
    const cur = this.jobs.get(id); if (!cur) throw new AppError(404, 'JOB_NOT_FOUND', 'Job not found.');
    const patch = mutator(clone(cur)); if (!patch) return clone(cur);
    const next = applyPatch(cur, patch); this.jobs.set(id, next); return clone(next);
  }
  async listJobsByStatus(statuses) { return [...this.jobs.values()].filter((j) => statuses.includes(j.status)).map(clone); }
}
