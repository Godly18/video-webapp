import { spawn, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { projectTotalMs } from '../domain/renderPlanner.js';
import path from 'node:path';

// `nice -n 19` is part of coreutils on Linux; detect once so a missing binary never breaks processing.
const NICE_OK = process.platform === 'linux' && (() => { try { return spawnSync('nice', ['-n', '19', 'true']).status === 0; } catch { return false; } })();

export function run(cmd, args, { timeoutMs, signal, onStdoutLine, lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    const wrap = lowPriority && NICE_OK;
    const child = wrap ? spawn('nice', ['-n', '19', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }) : spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', buf = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      if (onStdoutLine) { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onStdoutLine(buf.slice(0, i)); buf = buf.slice(i + 1); } }
      else if (stdout.length < 1e6) stdout += d;
    });
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(e, { code: e.code === 'ENOENT' ? 'TOOL_MISSING' : e.code })); });
    child.on('close', (code, sig) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ code, signal: sig, stdout, stderr, timedOut, aborted: !!signal?.aborted }); });
  });
}

export function createFfmpegService(cfg) {
  const { ffmpegPath, ffprobePath, ffprobeTimeoutMs } = cfg.ffmpeg;
  const low = cfg.ffmpeg.lowPriority !== false;
  // At most N heavy FFmpeg processes at once (slots are handed directly to waiters, so the limit cannot be exceeded).
  let active = 0; const waiters = [];
  const release = () => { const w = waiters.shift(); if (w) w(); else active--; };
  async function heavy(fn) { if (active < (cfg.ffmpeg.heavyConcurrency || 1)) active++; else await new Promise((r) => waiters.push(r)); try { return await fn(); } finally { release(); } }

  /**
   * Exact content length from FFprobe's packet list (end of the last audio packet). Still FFprobe only: it reads packet headers, it does not decode.
   * Needed because raw/ADTS .aac, some MP3s and other stream-only files carry no real duration, so format=duration is a bitrate-based
   * ESTIMATE that can be off by many seconds (a 5:27 recording was reported as 5:17).
   */
  async function packetScanSeconds(file) {
    let end = NaN, count = 0;
    let r;
    try {
      r = await run(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], {
        timeoutMs: ffprobeTimeoutMs * 4,
        onStdoutLine: (line) => {
          const [pts, dur] = line.split(',');
          const t = Number(pts), d = Number(dur);
          if (!Number.isFinite(t)) return;
          count++;
          const e = t + (Number.isFinite(d) ? d : 0);
          if (!(e <= end)) end = e;
        },
      });
    } catch { return { ok: false }; }
    if (r.code !== 0 || count === 0 || !Number.isFinite(end) || end <= 0) return { ok: false };
    return { ok: true, seconds: end, packets: count };
  }

  /** Primary duration check. ok:false means "FFprobe could not produce a usable duration" (triggers fallback), unless permanent. */
  async function probeDuration(file) {
    let r;
    try {
      r = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { timeoutMs: ffprobeTimeoutMs });
    } catch (e) { return { ok: false, reason: e.code === 'TOOL_MISSING' ? 'FFPROBE_UNAVAILABLE' : 'FFPROBE_ERROR' }; }
    if (r.code !== 0) return { ok: false, reason: 'FFPROBE_FAILED' };
    let j; try { j = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'FFPROBE_UNPARSEABLE' }; }
    const streams = Array.isArray(j.streams) ? j.streams : [];
    if (streams.length && !streams.some((s) => s.codec_type === 'audio')) return { ok: false, permanent: true, reason: 'NO_AUDIO_STREAM' };
    const formatSeconds = Number(j.format?.duration);
    const scan = await packetScanSeconds(file);
    if (scan.ok) return { ok: true, seconds: scan.seconds, method: 'ffprobe_packets', formatSeconds: Number.isFinite(formatSeconds) ? formatSeconds : null };
    if (!Number.isFinite(formatSeconds) || formatSeconds <= 0) return { ok: false, reason: 'FFPROBE_NO_DURATION' };
    return { ok: true, seconds: formatSeconds, method: 'ffprobe_format', formatSeconds };
  }

  /**
   * Re-wrap the narration as 16 kHz mono PCM WAV for the transcription model. Raw/ADTS .aac (and some other stream-only files) have no real
   * duration, and the transcription service cuts such audio at its own bitrate-based length estimate (seen: transcript ended 10 s early).
   * A WAV header carries the exact length. Timing is unchanged (no trimming, no speed change); speech models downsample to 16 kHz mono anyway.
   */
  async function transcodeForTranscription(inFile, outFile, { signal } = {}) {
    const r = await heavy(() => run(ffmpegPath, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-i', inFile, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outFile], { timeoutMs: cfg.ffmpeg.transcodeTimeoutMs, signal, lowPriority: low }));
    if (r.timedOut) throw Object.assign(new Error('transcode timed out'), { code: 'TRANSCODE_TIMEOUT' });
    if (r.code !== 0) throw Object.assign(new Error('transcode failed: ' + r.stderr.slice(-300)), { code: 'TRANSCODE_FAILED' });
  }

  /**
   * Cut [startSeconds, endSeconds) out of the narration and encode it. Output-side seeking (decode from the start, discard until startSeconds) is
   * sample-accurate for every input, including raw .aac which has no index. The original file is never modified.
   */
  async function cutAudio({ inFile, outFile, startSeconds, endSeconds, format = 'mp3', signal }) {
    const codec = { mp3: ['-c:a', 'libmp3lame', '-q:a', '2'], wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] }[format];
    if (!codec) throw new Error('unsupported audio format');
    const r = await heavy(() => run(ffmpegPath, ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', '-i', inFile, '-vn', '-map', '0:a:0', '-ss', startSeconds.toFixed(3), '-t', (endSeconds - startSeconds).toFixed(3), ...codec, outFile],
      { timeoutMs: cfg.ffmpeg.transcodeTimeoutMs, signal, lowPriority: low }));
    if (r.timedOut) throw Object.assign(new Error('audio cut timed out'), { code: 'CUT_TIMEOUT' });
    if (r.code !== 0) throw Object.assign(new Error('audio cut failed: ' + r.stderr.slice(-300)), { code: 'CUT_FAILED' });
  }

  /** Streams of the file's audio details for post-render diagnostics. */
  async function inspect(file) {
    const r = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file], { timeoutMs: ffprobeTimeoutMs });
    if (r.code !== 0) throw new Error('ffprobe failed on output');
    const j = JSON.parse(r.stdout);
    return { duration: Number(j.format?.duration), streams: j.streams || [] };
  }

  /**
   * NOTE: plain -re lets ffmpeg read 0.5s ahead (default initial burst), which would under-measure by ~0.5s; the burst is set to ~0 so
   * elapsed ~= true duration (+ ~30ms process start-up).
   * Fallback duration: decode the audio at native speed (-re, never faster) and measure elapsed wall time with a monotonic clock.
   * Valid only if ffmpeg exits 0 AND its own decoded-position progress agrees with the elapsed time.
   * If playback runs past maxSeconds it is stopped and reported as a LOWER BOUND (exact:false) so it can only mean "over the limit".
   */
  async function measurePlayback(file, { maxSeconds, signal, onProgress } = {}) {
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-readrate', '1', '-readrate_initial_burst', '0.0001', '-i', file, '-vn', '-map', '0:a:0', '-f', 'null', '-'];
    let outSeconds = 0, capped = false;
    const t0 = process.hrtime.bigint();
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const capTimer = maxSeconds ? setTimeout(() => { capped = true; ctl.abort(); }, maxSeconds * 1000) : null;
    let r;
    try {
      r = await run(ffmpegPath, args, { signal: ctl.signal, onStdoutLine: (line) => {
        const m = /^out_time_us=(\d+)/.exec(line) || /^out_time_ms=(\d+)/.exec(line);
        if (m) { outSeconds = Number(m[1]) / 1e6; onProgress?.(outSeconds); }
      } });
    } catch (e) { return { ok: false, reason: e.code === 'TOOL_MISSING' ? 'FFMPEG_UNAVAILABLE' : 'PLAYBACK_ERROR' }; }
    finally { clearTimeout(capTimer); signal?.removeEventListener('abort', onAbort); }
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
    if (capped) return { ok: true, exact: false, seconds: maxSeconds, elapsed };
    if (signal?.aborted) return { ok: false, reason: 'ABORTED' };
    if (r.code !== 0) return { ok: false, reason: 'PLAYBACK_FAILED' };
    if (!(outSeconds > 0) || Math.abs(elapsed - outSeconds) > 3 + 0.03 * elapsed) return { ok: false, reason: 'PLAYBACK_NOT_REALTIME', elapsed, outSeconds };
    return { ok: true, exact: true, seconds: elapsed, decodedSeconds: outSeconds };
  }

  /**
   * segments: [{file, from, to}] contiguous and covering [0, durationSeconds]. Audio is re-encoded to AAC, never trimmed, stretched or sped up.
   */
  /**
   * segments: [{file, from, to}] contiguous, covering [0, totalSeconds]. Audio is re-encoded to AAC, never trimmed, stretched or sped up.
   * Cheap-by-design pipeline: scale/pad/format run ONCE per image (before the fps filter duplicates frames), 1 thread, ultrafast + stillimage tune.
   * Budget: if the render is projected to exceed budgetMs it is aborted with code RENDER_TOO_SLOW so the caller can retry at a lower fps.
   */
  async function renderVideo({ segments, audioPath, outPath, workDir, signal, fps: fpsOverride, totalSeconds, budgetMs, minSampleMs = 30_000, timeoutMs: timeoutOverride, onProgress }) {
    const { width: W, height: H, fit, crf, preset = 'ultrafast', tune = 'stillimage', threads = 1 } = cfg.render;
    const fps = fpsOverride || cfg.render.fps, timeoutMs = timeoutOverride || cfg.render.timeoutMs;
    const lines = ['ffconcat version 1.0'];
    segments.forEach((s) => { lines.push(`file '${s.file.replace(/'/g, "'\\''")}'`, `duration ${(s.to - s.from).toFixed(6)}`); });
    lines.push(`file '${segments[segments.length - 1].file.replace(/'/g, "'\\''")}'`); // concat demuxer quirk: last file repeated so its duration is honoured
    const listPath = path.join(workDir, 'segments.ffconcat');
    await writeFile(listPath, lines.join('\n') + '\n');
    const scale = fit === 'cover'
      ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const vf = `${scale},setsar=1,format=yuv420p,fps=${fps}`; // format BEFORE fps: colour conversion happens once per image, not once per duplicated frame
    const T = String(threads);
    const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-filter_threads', '1', '-threads', T, '-f', 'concat', '-safe', '0', '-i', listPath, '-threads', '1', '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-vf', vf, '-c:v', 'libx264', '-preset', preset, ...(tune ? ['-tune', tune] : []), '-threads', T, '-crf', String(crf), '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath];
    const ctl = new AbortController(), onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let slow = null;
    const t0 = Date.now();
    const onLine = (line) => {
      const m = /^out_time_us=(\d+)/.exec(line); if (!m) return;
      const rendered = Number(m[1]) / 1e6, elapsedMs = Date.now() - t0;
      onProgress?.({ renderedSeconds: rendered, totalSeconds, elapsedMs, fps });
      if (budgetMs && totalSeconds && !slow) {
        const projectedMs = projectTotalMs({ elapsedMs, renderedSeconds: rendered, totalSeconds, minSampleMs });
        if (projectedMs && projectedMs > budgetMs) { slow = { projectedMs, elapsedMs, fps }; ctl.abort(); }
      }
    };
    let r;
    try { r = await heavy(() => run(ffmpegPath, args, { timeoutMs, signal: ctl.signal, lowPriority: low, onStdoutLine: onLine })); }
    finally { signal?.removeEventListener('abort', onAbort); }
    if (slow) throw Object.assign(new Error('Render projected to exceed the time budget'), { code: 'RENDER_TOO_SLOW', ...slow });
    if (r.timedOut) throw Object.assign(new Error('Render timed out'), { code: 'RENDER_TIMEOUT' });
    if (r.code !== 0) throw Object.assign(new Error('FFmpeg render failed: ' + r.stderr.slice(-500)), { code: 'RENDER_FAILED' });
  }

  return { probeDuration, measurePlayback, renderVideo, inspect, transcodeForTranscription, cutAudio };
}
