import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every tunable lives here. Nothing else may hardcode the 25-minute limit or the one-hour window. */
export function loadConfig(env = process.env) {
  const str = (k, d = '') => (env[k] === undefined || env[k] === '' ? d : env[k]);
  const num = (k, d) => {
    const raw = env[k];
    if (raw === undefined || raw === '') return d;
    const n = Number(String(raw).split('#')[0].trim());
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid numeric setting ${k}=${raw}`);
    return n;
  };
  const production = str('NODE_ENV') === 'production';
  const cfg = {
    production,
    port: num('PORT', 3000),
    host: '0.0.0.0',
    publicDir: path.join(root, 'public'),
    cronSecret: str('CRON_SECRET'),
    drivers: {
      db: str('DB_DRIVER', production ? 'firestore' : 'memory'),
      storage: str('STORAGE_DRIVER', production ? 'r2' : 'local'),
      localDir: path.resolve(root, str('LOCAL_DATA_DIR', '.local-data')),
    },
    limits: {
      maxAudioSeconds: num('MAX_AUDIO_SECONDS', 1500),
      returnWindowMs: num('RETURN_WINDOW_MINUTES', 60) * 60_000,
      maxAudioBytes: num('MAX_AUDIO_MB', 200) * MB,
      maxImageBytes: num('MAX_IMAGE_MB', 15) * MB,
      maxDocBytes: num('MAX_DOC_MB', 2) * MB,
      maxBatches: 100,
      maxImages: 1000,
      maxConcurrentUploads: 4,
    },
    ffmpeg: {
      ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
      ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
      ffprobeTimeoutMs: num('FFPROBE_TIMEOUT_SECONDS', 30) * 1000,
      playbackGraceSeconds: num('PLAYBACK_GRACE_SECONDS', 5),
      transcodeTimeoutMs: num('TRANSCODE_TIMEOUT_MINUTES', 15) * 60_000,
      heavyConcurrency: num('FFMPEG_HEAVY_CONCURRENCY', 1), // max simultaneous render/transcode FFmpeg processes
      lowPriority: str('FFMPEG_LOW_PRIORITY', '1') === '1', // run heavy FFmpeg with `nice -n 19` so the web server always gets CPU first
    },
    render: {
      width: num('RENDER_WIDTH', 1920),
      height: num('RENDER_HEIGHT', 1080),
      fps: num('RENDER_FPS', 30),
      fit: str('RENDER_FIT', 'contain'),
      crf: num('RENDER_CRF', 23),
      preset: str('RENDER_PRESET', 'ultrafast'),
      tune: str('RENDER_TUNE', 'stillimage'),
      budgetMs: num('RENDER_BUDGET_MINUTES', 25) * 60_000, // if a render is projected to take longer, fps is stepped down (restart) to fit
      threads: num('RENDER_THREADS', 1), // FFmpeg defaults to one thread per visible host core, which starves a small container
      timeoutMs: num('RENDER_TIMEOUT_MINUTES', 30) * 60_000,
    },
    jobs: {
      heartbeatMs: num('JOB_HEARTBEAT_SECONDS', 20) * 1000,
      staleMs: num('JOB_STALE_SECONDS', 90) * 1000,
      maxAttempts: num('JOB_MAX_ATTEMPTS', 2),
      retryBaseMs: 2000,
      concurrency: {
        audioDuration: num('CONCURRENCY_AUDIO_DURATION', 3),
        audioTranscription: num('CONCURRENCY_TRANSCRIPTION', 2),
        batchSynchronization: num('CONCURRENCY_SYNC', 2),
        videoRendering: num('CONCURRENCY_RENDER', 1),
      },
    },
    remote: { // run heavy jobs on GitHub Actions instead of this (small) instance
      types: new Set(str('REMOTE_JOB_TYPES').split(',').map((x) => x.trim()).filter(Boolean)),   // e.g. videoRendering,audioTranscription ; empty = everything local
      token: str('GH_DISPATCH_TOKEN'), repo: str('GH_REPO'), workflow: str('GH_WORKFLOW', 'render-job.yml'), ref: str('GH_REF', 'main'),
      startTimeoutMs: num('REMOTE_START_TIMEOUT_MINUTES', 5) * 60_000,   // runner must claim the job within this long, else fall back to local
      staleMs: num('REMOTE_STALE_MINUTES', 3) * 60_000,                  // a claimed job must show a runner heartbeat at least this often
      fallbackLocal: str('REMOTE_FALLBACK_LOCAL', '1') === '1', pollMs: 5000,
    },
    videos: { retentionMs: num('VIDEO_RETENTION_DAYS', 7) * 86_400_000, maxPerUser: num('MAX_VIDEOS_PER_USER', 20) }, // the "Videos" library
    downloads: { viaStorage: str('DOWNLOAD_VIA_STORAGE', '1') === '1', linkSeconds: num('DOWNLOAD_LINK_SECONDS', 600) }, // big files are served by R2 via short-lived links, not by this server
    batchAudioFormat: ['mp3', 'wav', 'm4a'].includes(str('BATCH_AUDIO_FORMAT', 'mp3')) ? str('BATCH_AUDIO_FORMAT', 'mp3') : 'mp3',
    healthGate: str('HEALTH_GATE', '1') === '1', // answer /health from a dedicated worker thread
    cleanupIntervalMs: num('CLEANUP_INTERVAL_SECONDS', 300) * 1000,
    gemini: {
      apiKey: str('GEMINI_API_KEY'),
      model: str('GEMINI_TRANSCRIBE_MODEL', 'gemini-3.5-transcribe'),
      languageCodes: str('GEMINI_LANGUAGE_CODES').split(',').map((s) => s.trim()).filter(Boolean),
    },
    firebase: {
      projectId: str('FIREBASE_PROJECT_ID'),
      serviceAccountJson: str('FIREBASE_SERVICE_ACCOUNT_JSON'),
    },
    r2: {
      accountId: str('CLOUDFLARE_ACCOUNT_ID'),
      bucket: str('R2_BUCKET_NAME'),
      accessKeyId: str('R2_ACCESS_KEY_ID'),
      secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
      endpoint: str('R2_ENDPOINT') || (str('CLOUDFLARE_ACCOUNT_ID') ? `https://${str('CLOUDFLARE_ACCOUNT_ID')}.r2.cloudflarestorage.com` : ''),
    },
  };
  if (!['contain', 'cover'].includes(cfg.render.fit)) throw new Error('RENDER_FIT must be contain or cover');
  if (production) {
    const problems = [];
    if (cfg.drivers.db !== 'firestore') problems.push('DB_DRIVER must be firestore in production');
    if (cfg.drivers.storage !== 'r2') problems.push('STORAGE_DRIVER must be r2 in production');
    if (problems.length) throw new Error(problems.join('; '));
  }
  return cfg;
}
export function requireDriverConfig(cfg) {
  const missing = [];
  if (cfg.drivers.db === 'firestore' && !cfg.firebase.projectId && !cfg.firebase.serviceAccountJson) missing.push('FIREBASE_PROJECT_ID or FIREBASE_SERVICE_ACCOUNT_JSON');
  if (cfg.drivers.storage === 'r2') for (const [k, v] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: cfg.r2.accountId || cfg.r2.endpoint, R2_BUCKET_NAME: cfg.r2.bucket, R2_ACCESS_KEY_ID: cfg.r2.accessKeyId, R2_SECRET_ACCESS_KEY: cfg.r2.secretAccessKey })) if (!v) missing.push(k);
  if (missing.length) throw new Error('Missing required configuration: ' + missing.join(', '));
}

/** Remote runners take output-affecting settings (size, fps, fit, quality, limits) from the web service so the video matches its configuration. */
export function applyConfigSnapshot(cfg, snap) {
  if (!snap) return cfg;
  Object.assign(cfg.render, snap.render || {});
  if (snap.limits?.maxAudioSeconds) cfg.limits.maxAudioSeconds = snap.limits.maxAudioSeconds;
  return cfg;
}
