# Still-Image Video Generator

Upload one narration audio file (max 25 min), text batches containing `[image_N]` markers, and tagged images.
The app transcribes the audio with Gemini (verbatim, word-level timestamps), matches your batches and markers to the
transcript, and renders one MP4 (H.264 + AAC) with the original audio untouched.

One Render **web service** only. Background work runs inside it. **No separate worker is needed.**

Stack: Node 20+ (plain `node:http`, no web framework), vanilla JS front end (no build), FFmpeg/FFprobe,
Firestore (state), Cloudflare R2 (media), Google Gemini (transcription).

## How it works (short)

| Concern | Rule |
|---|---|
| Identification | Email only. `userId = SHA-256(trim+NFKC+lowercase(email))`. No password/OTP. Anyone who knows an email can open its progress (by design). |
| Task states | `task.audioDuration / audioTranscription / batchSynchronization / videoRendering` are exactly `"pending"`, `"finished"` or real `null`. Never `"done"` (that is the UI button). Failure/expiry/interrupted details live in `taskMeta.<task>` and the `jobs` collection. |
| Duration | FFprobe first. Only if FFprobe cannot give a valid duration, an in-process playback fallback runs (`ffmpeg -readrate 1`, monotonic clock, never faster than real time). Limit is strict: `1500` ok, `>1500` rejected. Backend re-checks before enabling Done. |
| Batch end | END timestamp of the final word of the matched ending phrase. |
| Image start | START timestamp of the first word after the marker. End = next image start; last image ends at the authoritative duration. |
| Ambiguity | Repeated phrases are extended with context; if still ambiguous or unmatched the review screen lists candidates (with timestamps) and **blocks rendering** until you pick one. Nothing is guessed. |
| Image tags | `<batch>_<image>`; numbering restarts per batch (`2_1` is `[image_1]` of batch 2). |
| Return window | `expiresAt = max(last activity, last job heartbeat, last task completion) + RETURN_WINDOW_MINUTES` (server clock). Running jobs keep extending it; a finished result is kept one full window after completion. |
| Cleanup | Timer every `CLEANUP_INTERVAL_SECONDS` + at boot + optional external call to `POST /api/internal/cleanup` (header `x-cron-secret`). Skips projects with a live job; idempotent; failed deletions are retried. |

### Background jobs on a single web service (honest limits)

Jobs run in-process with per-type concurrency limits. The queue itself is **not** durable. What *is* durable is the
state: every job (`jobs/{id}`) and task status (`projects/{id}`) is in Firestore, inputs and outputs are in R2.

* A heartbeat is written every `JOB_HEARTBEAT_SECONDS`. After a restart/deploy, `recover()` (at boot and periodically) finds
  jobs whose heartbeat is older than `JOB_STALE_SECONDS`, and either **retries them from the stored R2 inputs** (attempt + 1) or,
  when `JOB_MAX_ATTEMPTS` is used up, marks them `interrupted` (task back to `null`, retry button shown). A restart never marks anything `finished`.
* Commits are fenced by `(jobId, attempt)`: a superseded/zombie attempt cannot overwrite a newer result.
* An interrupted playback-fallback check restarts from the beginning (it cannot be resumed), so a 20-minute check interrupted at minute 19 costs another 20 minutes.
* An uptime monitor pinging `/health` reduces free-tier sleeping but cannot prevent restarts, deploys or OOM kills. Free Render instances (512 MB RAM, shared CPU) can be slow or run out of memory on long renders; use a paid instance if renders fail.
* Instance disk is ephemeral; only temp files live there.

## Local development

```bash
npm install
cp .env.example .env     # for local dev set NODE_ENV=development DB_DRIVER=memory STORAGE_DRIVER=local
# FFmpeg + FFprobe must be on PATH (brew/apt install ffmpeg)
node --env-file=.env src/index.js      # http://localhost:3000
npm test
```
Dev mode uses an in-memory DB and local-disk storage (not durable). **Production refuses to start** with those drivers or with missing credentials.
Transcription needs a real `GEMINI_API_KEY` even locally.

## External setup you must do

### 1. Firestore
1. Firebase console → create a project → Build → Firestore Database → create (Native mode, production rules).
2. Rules: deny all client access (only the server uses the Admin SDK): `rules_version='2'; service cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if false; } } }`
3. Project settings → Service accounts → Generate new private key. Paste the JSON (or its base64) into Render env `FIREBASE_SERVICE_ACCOUNT_JSON`; set `FIREBASE_PROJECT_ID`. Never commit the key.
4. Collections are created automatically: `users`, `projects`, `jobs`. Only single-field queries are used, so no composite index is needed.

### 2. Cloudflare R2 (private bucket)
1. R2 → Create bucket (leave **public access disabled**; do not attach a custom/public domain).
2. R2 → Manage API tokens → Create API token with *Object Read & Write* limited to that bucket.
3. Set `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (endpoint defaults to `https://<account>.r2.cloudflarestorage.com`).
4. Optional safety net: add an R2 lifecycle rule deleting objects under `users/` after 2 days.

### 3. Gemini API key
1. https://aistudio.google.com/apikey → create key → `GEMINI_API_KEY`.
2. Model: `GEMINI_TRANSCRIBE_MODEL=gemini-3.5-transcribe`. Per the official transcription doc (fetched 2026‑10‑13) this is the dedicated speech model; it is **not** the same as a "Lite" text model. It supports verbatim mode and word-level timestamps (`mode.type="verbatim"`, `timestamp_granularities=["word"]`), and word timestamps are supported for audio up to 30 minutes, which covers the 25-minute limit without chunking. The doc warns word timestamps may reduce accuracy.
3. **Not verified:** whether this model is on your account's free tier and its quota. Check https://ai.google.dev/gemini-api/docs/pricing and the rate-limits page. Quota errors surface as a clear message with a retry button.
4. The code uses the Interactions API through `@google/genai`; make sure the installed SDK version exposes `client.interactions` (`npm i @google/genai@latest` if you see `GEMINI_SDK_OUTDATED`).

### 4. Render
1. Push this folder to GitHub. Render → New → Blueprint (uses `render.yaml`) or New → Web Service, **Runtime: Docker** (the Dockerfile installs FFmpeg/FFprobe). Health check path: `/health`.
2. Add the environment variables below as secrets. Render supplies `PORT`; the server binds `0.0.0.0:$PORT`.
3. Create an uptime monitor hitting `https://<service>.onrender.com/health` every 5 min (optional second monitor: `POST /api/internal/cleanup` with header `x-cron-secret: <CRON_SECRET>`).
4. After deploy, check the logs for "listening" and no "FFprobe/FFmpeg not found" error.

## Environment variables

See `.env.example` for defaults. Required in production: `FIREBASE_SERVICE_ACCOUNT_JSON` (or `FIREBASE_PROJECT_ID` + default credentials), `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `GEMINI_API_KEY`, `CRON_SECRET`.

| Variable | Meaning |
|---|---|
| `MAX_AUDIO_SECONDS` (1500) | Duration limit, single source of truth (also sent to the UI) |
| `RETURN_WINDOW_MINUTES` (60) | Resume/retention window |
| `MAX_AUDIO_MB`, `MAX_IMAGE_MB`, `MAX_DOC_MB` | Upload caps |
| `DB_DRIVER`, `STORAGE_DRIVER`, `LOCAL_DATA_DIR` | `firestore`/`r2` (prod) or `memory`/`local` (dev/test only) |
| `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_LANGUAGE_CODES` | Model id; optional BCP-47 hints |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `FFPROBE_TIMEOUT_SECONDS`, `PLAYBACK_GRACE_SECONDS` | Media tools; fallback stops this many seconds past the limit and reports a lower bound |
| `RENDER_WIDTH/HEIGHT/FPS/FIT/CRF`, `RENDER_TIMEOUT_MINUTES` | Output settings (`FIT=contain` letterboxes, `cover` crops) |
| `JOB_HEARTBEAT_SECONDS`, `JOB_STALE_SECONDS`, `JOB_MAX_ATTEMPTS`, `CONCURRENCY_*` | In-process job controls |
| `CLEANUP_INTERVAL_SECONDS`, `CRON_SECRET` | Cleanup cadence and the secret for the external trigger |

## API (all JSON; project routes need header `X-User-Email`)

`GET /health` · `GET /api/config` · `POST /api/users/identify` · `POST /api/projects` · `GET /api/projects/:id` ·
`PUT /api/projects/:id/audio?filename=` (raw body) · `GET …/audio/duration-status` · `POST …/audio/retry` · `POST …/audio/done` ·
`POST …/transcribe` · `GET …/transcript` · `PUT …/batches?number=&filename=` · `POST …/batches/order` · `DELETE …/batches/:n` ·
`PUT …/images?tag=1_1&filename=` · `DELETE …/images/:id` · `POST …/batches/:n/confirm-images` · `POST …/stage` ·
`POST …/sync` · `GET …/sync-status` · `POST …/sync/resolve` · `POST …/render` · `GET …/render-status` · `GET …/download` ·
`POST …/leave` (best-effort beacon) · `POST /api/internal/cleanup` (secret).

## Layout

```
src/domain/    pure logic: duration, matcher, timeline (sync), imageMapping, markers, taskState
src/services/  ffmpeg (probe, playback fallback, render), gemini, sync loader
src/jobs/      JobService (queue, heartbeat, fencing, recovery), handlers, cleanup
src/db|storage Firestore/R2 drivers (+ memory/local for dev & tests)
src/app.js     routes;  src/http.js helpers;  src/view.js client-safe projection
public/        UI (index.html, client.js, style.css)
test/          unit + end-to-end tests
```

## Tests actually run (Node 22.22, FFmpeg 6.1.1, in the build sandbox)

`npm test` → **38 tests, 38 pass, 0 fail.** Unit tests: duration rules (incl. 1500 vs 1500.001, fallback only when FFprobe fails, failed fallback never enables Done),
task vocabulary, tag mapping, matching (punctuation/case/line breaks, repeated phrases, ambiguity, end-of-word vs start-of-word rules, final image to full duration, bad timestamps),
Gemini response parsing. Integration/e2e (real FFmpeg/FFprobe, real HTTP server, in-memory DB + local-disk storage, faked Gemini): full workflow to a downloaded MP4 (H.264/AAC, duration matches audio),
real playback fallback with API staying responsive and no duplicate job on return, restart recovery + zombie-attempt fencing, interrupted-with-no-attempts-left, render/storage failures never `finished`,
ambiguity resolution persisted, expiry + idempotent cleanup, cleanup skipping live jobs and retrying failed deletes, upload/ownership validation, `/health`.
A fix found by these tests: plain `-re` reads 0.5 s ahead, under-measuring the fallback duration; the code now sets `-readrate_initial_burst 0.0001` (measured 3.03 s for a 3 s file).

`scripts/ui-smoke.mjs` (optional, needs Playwright): all 11 UI steps pass.
A UI bug found this way: the page re-rendered before reading the email box / chosen files, so Continue sent an empty email and the error was not displayed. Fixed.

## NOT tested / limitations (please read)

* **No live Firestore, R2 or Gemini call has been made** (sandbox had no network, `npm install` was not run). Those three drivers are written to the documented APIs but are untested against the real services; the first deploy is their first real run. Gemini transcription is tested only against a fake that returns the documented response shape.
* The browser UI was driven end to end in headless Chromium (`scripts/ui-smoke.mjs`: email → audio → batches → images → review → render → download → re-identify) against a fake Gemini. It has not been tried on real Safari/Firefox or on mobile, nor against the live Render deployment.
* JavaScript (ESM) with JSDoc comments rather than TypeScript, because no project existed and no compiler could be installed offline.
* Numerals are not expanded (`26` will not match "twenty six" exactly); such text falls to fuzzy matching or manual confirmation. Fuzzy matches are flagged for review.
* Word timestamps from the model can be imperfect; the review screen shows every computed time so you can inspect them. Wrong-but-plausible transcriptions can still mis-time an image.
* Playback-fallback precision is about ±0.1 s. If playback passes the limit by `PLAYBACK_GRACE_SECONDS` it is stopped and recorded as an inexact lower bound ("over limit"), never as an exact duration.
* The first image is rendered from 0 s even if narration starts it later (flagged as a warning) to avoid black frames. Images shown for less than one frame are flagged, not silently dropped.
* Supported images: PNG, JPEG, WebP (no GIF). EXIF rotation is not specially handled.
* Rate limiting is in-memory per instance. Heartbeats cost a few Firestore writes per running job every 20 s.
* Cleaned project records stay in Firestore (files deleted) for diagnostics; there is no automatic record purge.
* Large uploads and renders on a free Render instance may hit memory/CPU/time limits.
