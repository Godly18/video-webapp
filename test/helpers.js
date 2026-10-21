import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createFfmpegService } from '../src/services/ffmpeg.js';
import { MemoryDb } from '../src/db/memory.js';
import { LocalStorage } from '../src/storage/local.js';

export const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');
/** Fake word timings: word i starts at i*0.3 and ends 0.25s later. */
export const fakeWords = (list = WORDS, step = 0.3) => list.map((word, index) => ({ word, index, startSeconds: +(index * step).toFixed(3), endSeconds: +(index * step + 0.25).toFixed(3) }));
export const fakeGemini = (words = fakeWords()) => ({ transcribe: async () => ({ text: words.map((w) => w.word).join(' '), words, model: 'fake-model' }) });

export function makeFixtures(seconds = 6) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fx-'));
  const sh = (args) => { const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)); };
  const wav = path.join(dir, 'narration.wav');
  sh(['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, wav]);
  const imgs = {};
  [['red', 'red', '64x48'], ['green', 'green', '48x64'], ['blue', 'blue', '64x64']].forEach(([n, c, s]) => { imgs[n] = path.join(dir, `${n}.png`); sh(['-f', 'lavfi', '-i', `color=c=${c}:s=${s}`, '-frames:v', '1', imgs[n]]); });
  return { dir, wav, imgs, read: (p) => readFileSync(p) };
}

export function makeEnv(overrides = {}) {
  return { NODE_ENV: 'test', LOCAL_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'data-')), RENDER_WIDTH: '320', RENDER_HEIGHT: '240', RENDER_FPS: '10', JOB_HEARTBEAT_SECONDS: '1', JOB_STALE_SECONDS: '2', CRON_SECRET: 'secret', ...overrides };
}

export async function startApp({ env = {}, ffOverride = {}, gemini = fakeGemini(), db = new MemoryDb(), storage, clock, remote } = {}) {
  const cfg = loadConfig(makeEnv(env));
  storage ||= new LocalStorage(cfg.drivers.localDir);
  const ff = { ...createFfmpegService(cfg), ...ffOverride };
  const now = clock || Date.now;
  const quiet = { error() {}, warn() {}, info() {} };
  const app = createApp({ cfg, db, storage, gemini, ff, now, log: quiet, ...(remote !== undefined ? { remote } : {}) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const email = 'Tester@Example.com ';
  const call = async (method, p, { body, headers = {}, raw } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'x-user-email': email, ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, json: ct.includes('json') ? await res.json() : null, buf: ct.includes('json') ? null : Buffer.from(await res.arrayBuffer()) };
  };
  const close = async () => { await app.jobs.shutdown(); await new Promise((r) => app.server.close(r)); };
  return { app, cfg, db, storage, ff, call, base, close, cleanup: app.cleanup };
}
export async function waitFor(fn, { timeout = 20000, every = 100 } = {}) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeout) throw new Error('waitFor timed out'); await new Promise((r) => setTimeout(r, every)); }
}
