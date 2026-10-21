/**
 * Runs ONE job on a GitHub Actions runner:  node src/remoteRunner.js <jobId>
 * It talks to the same Firestore + R2 as the web service and runs the same handler code, with the same fencing rules.
 * It only runs jobs the web service has dispatched to it (job.executor === 'github') and refuses everything else.
 */
import { loadConfig, requireDriverConfig, applyConfigSnapshot } from './config.js';
import { createFfmpegService } from './services/ffmpeg.js';
import { createGeminiService } from './services/gemini.js';
import { createFirestoreDb } from './db/firestore.js';
import { createR2Storage } from './storage/r2.js';
import { JobService } from './jobs/service.js';
import { registerHandlers } from './jobs/handlers.js';

const jobId = process.argv[2];
if (!jobId) { console.error('usage: node src/remoteRunner.js <jobId>'); process.exit(2); }
const cfg = loadConfig();
requireDriverConfig(cfg);
const db = await createFirestoreDb(cfg), storage = await createR2Storage(cfg);
const job = await db.getJob(jobId);
if (!job) { console.error('job not found'); process.exit(1); }
applyConfigSnapshot(cfg, job.cfgSnapshot);
const runId = process.env.GITHUB_RUN_ID || `manual_${Date.now()}`;
const jobs = new JobService({ db, cfg, instanceId: `gha_${runId}` });
registerHandlers({ jobs, db, storage, ff: createFfmpegService(cfg), gemini: createGeminiService(cfg), cfg });
const code = await jobs.runAsRunner(jobId, runId);
console.log(JSON.stringify({ evt: 'runner_done', jobId, exit: code }));
process.exit(code);
