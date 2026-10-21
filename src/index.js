import { loadConfig, requireDriverConfig } from './config.js';
import { createApp } from './app.js';
import { createFfmpegService } from './services/ffmpeg.js';
import { createGeminiService } from './services/gemini.js';
import { MemoryDb } from './db/memory.js';
import { LocalStorage } from './storage/local.js';
import { Worker } from 'node:worker_threads';

const cfg = loadConfig();
requireDriverConfig(cfg);
const log = console;

const db = cfg.drivers.db === 'firestore' ? await (await import('./db/firestore.js')).createFirestoreDb(cfg) : new MemoryDb();
const storage = cfg.drivers.storage === 'r2' ? await (await import('./storage/r2.js')).createR2Storage(cfg) : new LocalStorage(cfg.drivers.localDir);
if (!cfg.production && (cfg.drivers.db === 'memory' || cfg.drivers.storage === 'local')) log.warn('DEV MODE: using in-memory DB / local disk storage. Not durable. Never use in production.');
const ff = createFfmpegService(cfg);
const gemini = createGeminiService(cfg);

const { server, jobs, cleanup } = createApp({ cfg, db, storage, gemini, ff, log });
async function afterListen() {
  log.info(`listening on ${cfg.host}:${cfg.port}`);
  const probe = await ff.probeDuration('/dev/null').catch(() => ({ reason: 'FFPROBE_UNAVAILABLE' }));
  if (probe.reason === 'FFPROBE_UNAVAILABLE') log.error('FFprobe/FFmpeg not found on PATH: duration checks and rendering will fail.');
  // Boot-time recovery of jobs interrupted by a restart/deploy, then periodic sweeps (not just an in-process timer: also see POST /api/internal/cleanup).
  await jobs.recover().then((r) => log.info('job recovery', JSON.stringify(r))).catch((e) => log.error('recovery failed', e));
  jobs.startRecoveryLoop();
  const sweep = () => cleanup().catch((e) => log.error('cleanup failed', e));
  sweep(); setInterval(sweep, cfg.cleanupIntervalMs).unref();
}
if (cfg.healthGate) {
  // The app listens on an internal loopback port; a worker thread owns the public port, answers /health itself and proxies the rest.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const worker = new Worker(new URL('./healthGate.js', import.meta.url), { workerData: { port: cfg.port, host: cfg.host, target: server.address().port } });
  await new Promise((resolve, reject) => { worker.once('message', (m) => (m.listening ? resolve() : reject(new Error('health gate failed to listen: ' + m.error)))); worker.once('error', reject); });
  worker.on('error', (e) => { log.error('health gate crashed', e); process.exit(1); });  // let Render restart us rather than run without a front door
  worker.on('exit', (c) => { if (c !== 0) { log.error('health gate exited', c); process.exit(1); } });
  await afterListen();
} else server.listen(cfg.port, cfg.host, afterListen);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await jobs.shutdown(); server.close(); setTimeout(() => process.exit(0), 500).unref(); });
