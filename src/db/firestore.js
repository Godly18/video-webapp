import { DELETE, applyPatch } from '../lib/patch.js';
import { AppError } from '../lib/errors.js';

/**
 * Firestore driver. Layout:
 *   users/{sha256(email)}        email, createdAt, lastActivityAt, activeProjectId
 *   projects/{projectId}         userId, task{...}, taskMeta{...}, stage, expiresAt, batches{}, images{}, ...  (single-field indexes only)
 *   jobs/{jobId}                 userId, projectId, type, status, attempt, heartbeatAt, error, progress
 * Timestamps are server-generated epoch milliseconds (Date.now() on the server, never the client clock).
 */
export async function createFirestoreDb(cfg) {
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  if (!getApps().length) {
    let credential;
    const raw = cfg.firebase.serviceAccountJson;
    if (raw) {
      const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      credential = cert(JSON.parse(text));
    } else credential = applicationDefault();
    initializeApp({ credential, projectId: cfg.firebase.projectId || undefined });
  }
  const fs = getFirestore();
  fs.settings({ ignoreUndefinedProperties: true });
  const toFs = (patch) => Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === DELETE ? FieldValue.delete() : v]));
  const data = (snap) => (snap.exists ? snap.data() : null);

  async function txUpdate(col, id, mutator, notFound) {
    const ref = fs.collection(col).doc(id);
    return fs.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound;
      const cur = snap.data();
      const patch = mutator(structuredClone(cur));
      if (!patch) return cur;
      tx.update(ref, toFs(patch));
      return applyPatch(cur, patch);
    });
  }
  return {
    async getUser(id) { return data(await fs.collection('users').doc(id).get()); },
    async upsertUser(id, fields, createFields = {}) {
      const ref = fs.collection('users').doc(id);
      return fs.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const next = snap.exists ? { ...snap.data(), ...fields } : { ...createFields, ...fields };
        tx.set(ref, next, { merge: true }); return next;
      });
    },
    async getProject(id) { return data(await fs.collection('projects').doc(id).get()); },
    async createProject(doc) { await fs.collection('projects').doc(doc.id).create(doc); return doc; },
    updateProject: (id, mutator) => txUpdate('projects', id, mutator, new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found.')),
    async listProjectsExpiredBefore(ms) { return (await fs.collection('projects').where('expiresAt', '<=', ms).limit(200).get()).docs.map((d) => d.data()); },
    async getJob(id) { return data(await fs.collection('jobs').doc(id).get()); },
    async createJob(doc) { await fs.collection('jobs').doc(doc.id).create(doc); return doc; },
    updateJob: (id, mutator) => txUpdate('jobs', id, mutator, new AppError(404, 'JOB_NOT_FOUND', 'Job not found.')),
    async createVideo(doc) { await fs.collection('videos').doc(doc.id).create(doc); return doc; },
    async getVideo(id) { return data(await fs.collection('videos').doc(id).get()); },
    async listVideosByUser(userId) { return (await fs.collection('videos').where('userId', '==', userId).limit(200).get()).docs.map((d) => d.data()); },
    async deleteVideo(id) { await fs.collection('videos').doc(id).delete(); },
    async listVideosExpiredBefore(ms) { return (await fs.collection('videos').where('expiresAt', '<=', ms).limit(200).get()).docs.map((d) => d.data()); },
    async listJobsByStatus(statuses) { return (await fs.collection('jobs').where('status', 'in', statuses).limit(500).get()).docs.map((d) => d.data()); },
  };
}
