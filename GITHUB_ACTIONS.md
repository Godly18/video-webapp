# Running the heavy work on GitHub Actions

The web service (Render) stays the website and the API. When REMOTE_JOB_TYPES is set, each heavy job is handed to a GitHub Actions
runner (about 4 vCPU / 16 GB on public repos, 2 vCPU / 7 GB on private ones) instead of the small Render instance:

1. The user clicks Render. The web service creates the job as usual, then triggers the `render-job` workflow with the job id.
2. The runner (`src/remoteRunner.js`) claims the job in Firestore, downloads the inputs from R2, runs the same code, uploads the MP4 to R2,
   and only then marks the task `finished`. Progress and phases ("Encoding video… 54%") appear on the Export screen as before.
3. The web service just waits and watches the runner's heartbeat. The user can leave and return exactly as before.

If GitHub cannot be reached, the token is wrong/expired, or no runner picks the job up within 5 minutes, the web service **renders it itself**
(REMOTE_FALLBACK_LOCAL=1), so a GitHub problem slows things down but does not break them. If the runner dies mid-job, the job is retried once.

## One-time setup

1. **Workflow file.** `.github/workflows/render-job.yml` must be on your default branch (`main`). `workflow_dispatch` only works for files on that branch. Check the Actions tab shows "render-job".
2. **Runner secrets** (GitHub repo → Settings → Secrets and variables → Actions → New repository secret):
   `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID`, `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   and `GEMINI_API_KEY` (only if you also send transcription to GitHub). Use the same values as on Render.
3. **Dispatch token** (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate):
   resource owner = you, "Only select repositories" = this repo, Repository permissions → **Actions: Read and write** (Metadata: Read-only is added automatically).
   Choose an expiry and note the date: when it expires, jobs silently fall back to Render until you replace the token.
4. **Render environment variables** (Render → your service → Environment):
   `REMOTE_JOB_TYPES=videoRendering`, `GH_DISPATCH_TOKEN=<token>`, `GH_REPO=<owner>/<repo>` (for example `Godly18/video-webapp`). Save → Render redeploys.
5. **Try it:** start a render, then open the repo's Actions tab: a `render-job` run named `job videoRendering_…` should appear and the Export screen should say "Starting a faster render server…".

| Variable (Render) | Default | Meaning |
|---|---|---|
| `REMOTE_JOB_TYPES` | empty (all local) | Comma list of job types to run on GitHub: `videoRendering`, `audioTranscription` |
| `GH_DISPATCH_TOKEN` | – | Fine-grained token (Actions: read & write on this repo only) |
| `GH_REPO` | – | `owner/repo` |
| `GH_WORKFLOW` / `GH_REF` | `render-job.yml` / `main` | Workflow file name and branch |
| `REMOTE_START_TIMEOUT_MINUTES` | 5 | Runner must claim the job within this time, otherwise fall back |
| `REMOTE_STALE_MINUTES` | 3 | A claimed job must show a runner heartbeat this often, otherwise it is retried |
| `REMOTE_FALLBACK_LOCAL` | 1 | 1 = render on Render if GitHub is unavailable; 0 = fail with a retry message |

## Things to know

* **Cost:** public repos get free standard-runner minutes; private repos include a monthly allowance (2,000 min on the Free plan). A 5-minute video should occupy a runner for roughly 1-3 minutes including ~1 minute of setup (checkout, Node, FFmpeg, npm install).
* **Privacy:** the runner has your Firestore/R2 keys as masked secrets. On a **public** repo, workflow logs are public: this app logs job ids and error codes only (no emails or content), but a private repo is the safer choice. Never run this workflow from forks.
* **Output settings** (resolution, fps, fit, quality) are copied from the web service per job, so the video matches the settings on Render. Speed settings (threads, preset) are the workflow's own.
* **Not covered:** the website, API, uploads, and downloads still run on Render. Only the heavy jobs move.
* **Not yet exercised against real GitHub:** the logic is tested with an in-process stand-in for the runner and a fake GitHub endpoint; the real workflow has not been run.
