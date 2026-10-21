const STAGES = [['audio', '1 Audio'], ['batches', '2 Text batches'], ['images', '3 Images'], ['review', '4 Review'], ['export', '5 Export']];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { if (!Number.isFinite(s)) return '–'; const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`; };
const CLIENT_BUILD = new URL(import.meta.url).searchParams.get('v') || 'unknown';
let showVideos = false, videos = null, videosRetention = 7, audioFmt = null, email = sessionStorage.getItem('email') || '', draft = '', project = null, busy = false, notice = null, pending = {}, thumbs = {}, sig = '';

async function api(method, path, { body, raw, headers = {}, blob, onProgress } = {}) {
  const url = path;
  const h = { 'x-user-email': email, ...headers };
  if (body) h['content-type'] = 'application/json';
  if (raw && onProgress) return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open(method, url); Object.entries(h).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(j) : reject(Object.assign(new Error(j.error?.message || 'Upload failed'), { code: j.error?.code, status: x.status })); };
    x.onerror = () => reject(new Error('Network error during upload.')); x.send(raw);
  });
  const res = await fetch(url, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  if (blob && res.ok) return res.blob();
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(j.error?.message || 'Request failed'), { code: j.error?.code, status: res.status, details: j.error?.details });
    if (res.status === 410) { project = null; notice = { t: 'warn', m: j.error.message }; show(); }
    if (res.status === 401) { email = ''; sessionStorage.removeItem('email'); show(); }
    throw err;
  }
  return j;
}
// Never re-render BEFORE the action runs: actions read the current form fields (email box, chosen files, tags), and a re-render would wipe them.
const run = async (fn) => {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; }); document.body.style.cursor = 'progress';
  try { await fn(); }
  catch (e) { if (e.status !== 410 && e.status !== 401) notice = { t: 'err', m: e.message + (e.details?.length > 1 ? ' (' + e.details.length + ' problems)' : '') }; }
  finally { busy = false; document.body.style.cursor = ''; show(); }
};
const setProject = (p) => { project = p; };
const refresh = async () => setProject((await api('GET', `/api/projects/${project.id}`)).project);

function dialog(title, msg) { $('#dlgTitle').textContent = title; $('#dlgMsg').textContent = msg; $('#dlg').showModal(); }
const needsPoll = () => project && (Object.values(project.task).includes('pending') || (project.stage === 'review' && project.task.audioTranscription === 'finished' && project.task.batchSynchronization === null && !project.sync) || (project.task.audioTranscription === 'pending'));
setInterval(async () => {
  if (!project || document.hidden || busy || !needsPoll()) return;
  try {
    await refresh();
    if (project.stage === 'review' && project.task.audioTranscription === 'finished' && !project.task.batchSynchronization && !project.sync && !project.mappingProblems.length) await api('POST', `/api/projects/${project.id}/sync`).then((r) => setProject(r.project)).catch(() => {});
    const s = JSON.stringify([project.task, project.taskMeta, project.duration, project.sync?.computedAt, project.render?.outputId]);
    if (s !== sig) show();
  } catch { /* transient */ }
}, 3000);
// Best-effort page-exit signal. Never cancels a job; the server keeps working and keeps the result for the return window.
addEventListener('pagehide', () => { if (project && email) navigator.sendBeacon(`/api/projects/${project.id}/leave`, new Blob([JSON.stringify({ email })], { type: 'application/json' })); });

function show() {
  sig = project ? JSON.stringify([project.task, project.taskMeta, project.duration, project.sync?.computedAt, project.render?.outputId]) : '';
  const nav = $('#nav'), app = $('#app');
  nav.innerHTML = email ? `<span class="mut">${esc(email)}</span> <button data-a="videos">Videos</button> <button data-a="exit">Exit</button>` : '';
  const n = notice ? `<div class="msg ${notice.t}">${esc(notice.m)}</div>` : '';
  if (!email) app.innerHTML = n + identifyView(); else if (showVideos) app.innerHTML = n + videosView(); else if (!project) app.innerHTML = n + startView(); else app.innerHTML = n + stepsView() + ({ audio: audioView, batches: batchesView, images: imagesView, review: reviewView, export: exportView }[project.stage] || audioView)();
  notice = null; hydrateThumbs();
}
const stepsView = () => `<div class="steps">${STAGES.map(([k, l]) => `<span class="${k === project.stage ? 'on' : ''}">${l}</span>`).join('')}</div>
  <div class="row mut" style="margin-bottom:10px"><button data-a="back" ${project.stage === 'audio' || busy ? 'disabled' : ''}>← Back</button><span>Back and Exit never cancel background work. Your progress is kept for ${project.limits.returnWindowMinutes} minutes after you leave; enter the same email to resume.</span></div>`;

function identifyView() {
  return `<div class="card"><h2>Enter your email to begin</h2><p class="mut">This only identifies your saved progress. There is no password or verification; anyone who knows an email can open its progress.</p>
  <div class="row"><input id="email" type="email" placeholder="you@example.com" autocomplete="email" value="${esc(draft)}"><button class="primary" data-a="identify">Continue</button></div></div>`;
}
const startView = () => `<div class="card"><h2>New project</h2><p>Upload one narration audio file, the text batches, and the images. The app times each image to the spoken words.</p><button class="primary" data-a="newproject" ${busy ? 'disabled' : ''}>Start a new project</button></div>`;

// ---------- Stage 1 ----------
function audioView() {
  const p = project, t = p.task.audioDuration, m = p.taskMeta.audioDuration, d = p.duration, max = Math.round(p.limits.maxAudioSeconds / 60);
  let status = '';
  if (t === 'pending') status = m.phase === 'playback_fallback'
    ? `<div class="msg warn"><span class="spin"></span>We couldn't read the audio duration automatically. Please hold on while we check the audio another way. You can leave this page and return within one hour to check the result.${m.progress?.playedSeconds ? ` <span class="mut">(checked ${fmt(m.progress.playedSeconds)} so far)</span>` : ''}</div>`
    : `<div class="msg info"><span class="spin"></span>Checking audio duration…</div>`;
  else if (t === 'finished' && d) status = d.overLimit ? `<div class="msg err">Audio duration is longer than the ${max}-minute maximum${d.exact ? ` (${esc(d.display)})` : ''}. Please upload a shorter file.</div>` : `<div class="msg ok">Your audio duration is ${esc(d.display)}. <span class="mut">(source: ${esc(d.source)})</span></div>`;
  else if (m.jobStatus === 'failed' || m.jobStatus === 'interrupted') status = `<div class="msg err">Unable to check the audio duration. ${esc(m.error?.message || '')} <button data-a="retryDuration" ${busy ? 'disabled' : ''}>Retry check</button></div>`;
  if (m.error?.retrying && t === 'pending') status += `<div class="msg warn">${esc(m.error.message)}</div>`;
  if (p.audio && (m.jobStatus === 'failed') && !pending.errShown) { pending.errShown = true; dialog('Unable to Check Audio Duration', "We couldn't determine the duration of this audio file. Please provide a checkable audio file and try again."); }
  return `<div class="card"><h2>Narration audio</h2><p class="mut">One complete file, maximum ${max} minutes. ${p.audio ? `Uploaded: <b>${esc(p.audio.filename)}</b> (${(p.audio.size / 1048576).toFixed(1)} MB).` : ''}</p>
  <div class="row"><input type="file" id="audioFile" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm,.opus,.aiff"><button data-a="uploadAudio" ${busy || t === 'pending' ? 'disabled' : ''}>${p.audio ? 'Replace audio' : 'Upload audio'}</button></div>
  <div id="upbar" class="bar" style="display:none;margin-top:8px"><i style="width:0"></i></div>${status}
  <div class="row"><button class="primary" data-a="audioDone" ${p.doneEnabled && !busy ? '' : 'disabled'}>Done</button></div></div>`;
}
// ---------- Stage 2 ----------
function transcriptStatus() {
  const t = project.task.audioTranscription, m = project.taskMeta.audioTranscription;
  if (t === 'pending') return `<div class="msg info"><span class="spin"></span>Transcription is in progress. You can keep working.</div>`;
  if (t === 'finished') return `<div class="msg ok">Transcript ready (${project.transcript.wordCount} words with timestamps).</div>`;
  return `<div class="msg err">Transcription ${m.error ? 'failed: ' + esc(m.error.message) : 'has not started'}. <button data-a="transcribe" ${busy ? 'disabled' : ''}>Start / retry transcription</button></div>`;
}
function batchesView() {
  const p = project, order = p.batches;
  return `<div class="card"><h2>Text batches</h2>${transcriptStatus()}
  <p class="mut">Each document holds the words of one part of the narration, with markers like <code>[image_1]</code>. The batch number (used in image tags like <code>1_1</code>) is separate from the playback order below.</p>
  <div class="row"><input type="file" id="docFiles" accept=".txt,text/plain" multiple><button data-a="pickDocs" ${busy ? 'disabled' : ''}>Add files</button></div>
  <div id="docPending">${(pending.docs || []).map((d, i) => `<div class="row"><span>${esc(d.file.name)}</span> batch # <input type="number" min="1" style="width:80px" data-doc="${i}" value="${d.number}"></div>`).join('')}${pending.docs?.length ? `<button class="primary" data-a="uploadDocs" ${busy ? 'disabled' : ''}>Upload ${pending.docs.length} file(s)</button>` : ''}</div>
  ${order.length ? `<table><tr><th>Play order</th><th>Batch #</th><th>File</th><th>Words</th><th>Markers</th><th>Ends with</th><th></th></tr>${order.map((b, i) => `<tr><td>${i + 1}</td><td><b>${b.number}</b></td><td>${esc(b.filename)}</td><td>${b.wordCount}</td><td>${b.markers.map((m) => `[image_${m}]`).join(' ')}</td><td class="mut">…${esc(b.endPhrase)}</td><td><button data-a="up" data-n="${b.number}" ${i === 0 ? 'disabled' : ''}>↑</button><button data-a="down" data-n="${b.number}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button><button data-a="delBatch" data-n="${b.number}">Delete</button></td></tr>`).join('')}</table>` : ''}
  <div class="row" style="margin-top:12px"><button class="primary" data-a="toStage" data-s="images" ${order.length && !busy ? '' : 'disabled'}>Continue to images</button></div></div>`;
}
// ---------- Stage 3 ----------
function imagesView() {
  const p = project;
  return `<div class="card"><h2>Images</h2><p class="mut">Tag every image <code>batch_image</code>, e.g. <code>1_1</code>. Numbering restarts in every batch: <code>2_1</code> is [image_1] of batch 2.</p></div>` + p.batches.map((b) => {
    const imgs = p.images.filter((i) => i.batch === b.number).sort((a, c) => a.marker - c.marker);
    const have = new Set(imgs.map((i) => i.marker));
    const missing = b.markers.filter((m) => !have.has(m));
    const pend = pending['img' + b.number] || [];
    return `<div class="card"><h3>Batch ${b.number} <span class="mut">${esc(b.filename)}</span> ${b.imagesConfirmed ? '<span class="msg ok" style="padding:2px 8px">confirmed</span>' : ''}</h3>
    <div class="mut">Expected tags: ${b.markers.map((m) => `${b.number}_${m}`).join(', ')}${missing.length ? ` — <b style="color:var(--warn)">missing: ${missing.map((m) => `${b.number}_${m}`).join(', ')}</b>` : ''}</div>
    <div class="thumbs">${imgs.map((i) => `<div class="thumb"><img data-img="${i.id}" alt="${esc(i.tag)}"><b>${esc(i.tag)}</b> <span class="mut">${esc(i.filename)}</span><br><button data-a="delImg" data-id="${i.id}">Remove</button></div>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input type="file" id="img${b.number}" accept="image/png,image/jpeg,image/webp" multiple><button data-a="pickImgs" data-n="${b.number}">Add</button></div>
    ${pend.map((d, i) => `<div class="row"><span>${esc(d.file.name)}</span> tag <input type="text" style="width:90px" data-img-n="${b.number}" data-i="${i}" value="${esc(d.tag)}" placeholder="${b.number}_1"></div>`).join('')}
    ${pend.length ? `<button class="primary" data-a="uploadImgs" data-n="${b.number}" ${busy ? 'disabled' : ''}>Upload ${pend.length} image(s)</button>` : ''}
    <div class="row" style="margin-top:8px"><button class="primary" data-a="confirmImgs" data-n="${b.number}" ${busy ? 'disabled' : ''}>Done</button></div></div>`;
  }).join('') + `<div class="row"><button class="primary" data-a="toStage" data-s="review" ${p.batches.every((b) => b.imagesConfirmed) && !busy ? '' : 'disabled'}>Continue to synchronization review</button></div>`;
}
// ---------- audio by batch ----------
const batchAudioView = () => {
  const segs = project.batchAudio || []; if (!segs.length) return '';
  const cur = audioFmt || project.batchAudioFormat || 'mp3', nameOf = (n) => project.batches.find((b) => b.number === n)?.filename || `batch_${n}`;
  return `<h3>Audio by batch</h3><div class="row mut">Each part is cut from your original audio exactly at the batch boundaries. Format
    <select id="audioFmt">${['mp3', 'wav', 'm4a'].map((f) => `<option value="${f}" ${f === cur ? 'selected' : ''}>${f.toUpperCase()}</option>`).join('')}</select></div>
    <table><tr><th>Batch</th><th>From</th><th>To</th><th>Length</th><th></th></tr>${segs.map((g) => `<tr><td><b>${g.number}</b> <span class="mut">${esc(nameOf(g.number))}</span></td><td>${fmt(g.startSeconds)}</td><td>${fmt(g.endSeconds)}</td><td>${fmt(g.endSeconds - g.startSeconds)}</td><td><button data-a="dlBatchAudio" data-n="${g.number}" ${busy ? 'disabled' : ''}>⬇ Download</button></td></tr>`).join('')}</table>`;
};
// ---------- Stage 4 ----------
const transcriptDownloads = () => project.task.audioTranscription === 'finished' ? `<div class="row" style="margin:8px 0"><button data-a="dlTranscript">⬇ Download transcript (.txt)</button><button data-a="dlTranscriptTs">⬇ With timestamps (.txt)</button><button data-a="retranscribe">↻ Re-transcribe audio</button><span class="mut">Compare your document's ending with what was actually heard.</span></div>` : '';
function reviewView() {
  const p = project, s = p.sync, t = p.task.batchSynchronization, tr = p.task.audioTranscription;
  let head = '';
  if (tr === 'pending') head = `<div class="msg info"><span class="spin"></span>Waiting for transcription to finish…</div>`;
  else if (tr !== 'finished') head = transcriptStatus();
  else if (t === 'pending') head = `<div class="msg info"><span class="spin"></span>Synchronizing images with the transcript…</div>`;
  else if (!s) head = `<div class="msg info">Starting synchronization… ${p.taskMeta.batchSynchronization.error ? esc(p.taskMeta.batchSynchronization.error.message) : ''}<button data-a="sync">Run now</button></div>`;
  if (!s) return `<div class="card"><h2>Synchronization review</h2>${head}${transcriptDownloads()}</div>`;
  const why = (u) => u.method === 'fuzzy_low' ? 'No exact match was found. These are the closest passages in the transcript — please pick the right one (or fix the document and re-run).'
    : u.candidates.length ? 'Choose the correct place in the transcript:' : 'No place in the transcript matched this text closely enough.';
  const cand = (u) => `<div class="msg warn"><b>${u.kind === 'batch' ? 'Batch ' + u.id + ' ending' : 'Image ' + u.id + ' start'}: ${u.method === 'fuzzy_low' ? 'needs your confirmation' : esc(u.status)}.</b> ${why(u)}
    ${u.candidates.map((c) => `<div class="row"><span class="mut">${fmt(u.kind === 'batch' ? c.endSeconds : c.startSeconds)} · match ${Math.round((c.score ?? 1) * 100)}%</span> “…${esc(c.context)}…” <button data-a="resolve" data-k="${u.kind}" data-id="${esc(u.id)}" data-w="${c.wordIndex}">Use this</button></div>`).join('')}
    ${!u.candidates.length && u.closest ? `<div class="mut">Closest passage heard (${Math.round(u.closest.score * 100)}% similar, at ${fmt(u.closest.startSeconds)}): “…${esc(u.closest.context)}…”</div>` : ''}
    ${!u.candidates.length ? `<div class="mut">Download the transcript above and compare it with your document. If the transcript is missing this part, the audio may not have been fully transcribed.</div>` : ''}</div>`;
  return `<div class="card"><h2>Synchronization review</h2>${head}<p class="mut">Authoritative audio duration: <b>${esc(p.duration.display)}</b> (${esc(p.duration.source)})</p>
  ${s.errors.map((e) => `<div class="msg err">${esc(e.message)}</div>`).join('')}${s.warnings.map((e) => `<div class="msg warn">${esc(e.message)}</div>`).join('')}${s.unresolved.map(cand).join('')}
  ${transcriptDownloads()}
  <h3>Batches</h3><table><tr><th>#</th><th>Ending phrase</th><th>Ends at</th><th>Status</th></tr>${s.batches.map((b) => `<tr><td>${b.number}</td><td class="mut">…${esc(b.endPhrase)}</td><td>${fmt(b.endSeconds)}</td><td>${esc(b.status)}</td></tr>`).join('')}</table>
  <h3>Image timeline</h3><table><tr><th>Tag</th><th>Starts</th><th>Ends</th><th>First words</th><th>Status</th></tr>${s.images.map((i) => `<tr><td><b>${esc(i.tag)}</b></td><td>${fmt(i.startSeconds)}</td><td>${fmt(i.endSeconds)}</td><td class="mut">${esc(i.preview)}</td><td>${esc(i.status)}</td></tr>`).join('')}</table>
  ${batchAudioView()}
  <div class="row" style="margin-top:12px"><button data-a="sync" ${busy || t === 'pending' ? 'disabled' : ''}>Re-run synchronization</button><button class="primary" data-a="render" ${s.renderable && t === 'finished' && !busy ? '' : 'disabled'}>Render video</button></div>${s.renderable ? '' : '<div class="mut">Rendering stays disabled until every match is resolved and no errors remain.</div>'}</div>`;
}
// ---------- Stage 5 ----------
function exportView() {
  const p = project, t = p.task.videoRendering, m = p.taskMeta.videoRendering;
  let body = `<div class="msg info">Rendering has not started. <button class="primary" data-a="render" ${busy ? 'disabled' : ''}>Render video</button></div>`;
  if (t === 'pending') {
    const pr = m.progress, pct = pr?.totalSeconds ? Math.min(100, Math.round(100 * (pr.renderedSeconds || 0) / pr.totalSeconds)) : null;
    const secs = m.startedAt ? Math.max(0, Math.round((p.serverNow - m.startedAt) / 1000)) : null;
    const running = secs === null ? '' : ` Running for ${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s.`;
    const step = { starting: 1, preparing: 2, encoding: 3, uploading: 4 }[m.phase] ?? 1;
    const label = m.phase === 'uploading' ? 'Saving the finished video…' : m.phase === 'encoding' ? `Encoding video… ${pct ?? 0}%${pr?.fps ? ' (' + pr.fps + ' fps)' : ''}` : m.phase === 'preparing' ? 'Preparing your images and audio…' : 'Starting the render server (this can take about a minute)…';
    const note = m.error?.retrying ? ` <span class="mut">(${esc(m.error.message)})</span>` : '';
    const determinate = m.phase === 'encoding' || m.phase === 'uploading', width = m.phase === 'uploading' ? 100 : (pct ?? 0);
    body = `<div class="msg info"><span class="spin"></span><b>Step ${step} of 4 — ${label}</b>${note}<br>${running} You can leave and return within ${p.limits.returnWindowMinutes} minutes.</div>
      <div class="bar${determinate ? '' : ' ind'}" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${determinate ? `aria-valuenow="${width}"` : ''}><i ${determinate ? `style="width:${width}%"` : ''}></i></div>`;
  }
  else if (t === 'finished' && p.render) body = `<div class="msg ok">Your video is ready (${(p.render.size / 1048576).toFixed(1)} MB, ${p.render.width}×${p.render.height}${p.render.fps ? ' @ ' + p.render.fps + ' fps' : ''}).</div>${(p.render.warnings || []).map((w) => `<div class="msg warn">${esc(w)}</div>`).join('')}<button class="primary" data-a="download">Download MP4</button>`;
  else if (m.error) body = `<div class="msg err">Rendering failed: ${esc(m.error.message)} <button data-a="render" ${busy ? 'disabled' : ''}>Retry</button></div>`;
  return `<div class="card"><h2>Export</h2>${body}${batchAudioView()}<hr><button data-a="newOther">Start a new project</button></div>`;
}

// ---------- Videos library ----------
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
function videosView() {
  const rendering = project?.task?.videoRendering === 'pending';
  const rows = (videos || []).map((v) => `<tr><td><b>${esc(v.title)}</b><br><span class="mut">${new Date(v.createdAt).toLocaleString()}</span></td><td>${fmt(v.durationSeconds)}</td><td>${mb(v.size)}<br><span class="mut">${v.width}×${v.height} @ ${v.fps} fps</span></td><td class="mut">${new Date(v.expiresAt).toLocaleDateString()}</td>
    <td><button class="primary" data-a="dlVideo" data-id="${esc(v.id)}" ${busy ? 'disabled' : ''}>⬇ Download</button> <button data-a="delVideo" data-id="${esc(v.id)}" ${busy ? 'disabled' : ''}>Delete</button></td></tr>`).join('');
  return `<div class="card"><div class="row"><h2 style="margin:0">Your videos</h2><button data-a="refreshVideos" ${busy ? 'disabled' : ''}>↻ Refresh</button><button data-a="closeVideos">← Back</button></div>
    <p class="mut">Finished videos are kept for ${videosRetention} days, even after you start a new project. Downloads come straight from cloud storage.</p>
    ${rendering ? '<div class="msg info"><span class="spin"></span>A video is still rendering in your current project. It will appear here when it is finished — press Refresh.</div>' : ''}
    ${videos === null ? '<div class="msg info">Loading…</div>' : videos.length ? `<table><tr><th>Video</th><th>Length</th><th>File</th><th>Keep until</th><th></th></tr>${rows}</table>` : '<div class="msg info">No finished videos yet.</div>'}</div>`;
}
const loadVideos = async () => { const r = await api('GET', '/api/videos'); videos = r.videos; videosRetention = r.retentionDays; };
/** Download a stored file. The server answers with a short-lived direct link to cloud storage when it can (so the file does not pass through the web server). */
async function downloadFile(path, filename) {
  const res = await fetch(path + (path.includes('?') ? '&' : '?') + 'link=1', { headers: { 'x-user-email': email }, cache: 'no-store' });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.error?.message || 'Download failed'), { status: res.status }); }
  let href;
  if ((res.headers.get('content-type') || '').includes('application/json')) { const j = await res.json(); href = j.url; }
  else href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = href; a.download = filename; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  if (href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(href), 10000);
}

// ---------- hydrate thumbnails (images need the email header, so fetch as blobs) ----------
async function hydrateThumbs() {
  for (const el of document.querySelectorAll('img[data-img]')) {
    const id = el.dataset.img;
    if (!thumbs[id]) { try { thumbs[id] = URL.createObjectURL(await api('GET', `/api/projects/${project.id}/images/${id}/file`, { blob: true })); } catch { continue; } }
    el.src = thumbs[id];
  }
}
const guessNumber = () => { const used = new Set(project.batches.map((b) => b.number)); let n = 1; while (used.has(n)) n++; return n; };

// ---------- actions ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a, n = Number(el.dataset.n), id = project?.id;
  const act = {
    videos: () => run(async () => { await loadVideos(); showVideos = true; }),
    closeVideos: () => { showVideos = false; show(); },
    refreshVideos: () => run(loadVideos),
    dlVideo: () => run(() => { const v = videos.find((x) => x.id === el.dataset.id); return downloadFile(`/api/videos/${v.id}/download`, `${v.title}_${new Date(v.createdAt).toISOString().slice(0, 10)}.mp4`); }),
    delVideo: () => { if (confirm('Delete this video permanently?')) run(async () => { await api('DELETE', `/api/videos/${el.dataset.id}`); await loadVideos(); }); },
    exit: () => { showVideos = false; videos = null; draft = email; email = ''; project = null; pending = {}; sessionStorage.removeItem('email'); show(); },
    back: () => run(async () => { const i = STAGES.findIndex(([k]) => k === project.stage); setProject((await api('POST', `/api/projects/${id}/stage`, { body: { stage: STAGES[Math.max(0, i - 1)][0] } })).project); }),
    identify: () => run(async () => {
      draft = $('#email').value.trim();          // kept so a failed attempt does not wipe what was typed
      const r = await api('POST', '/api/users/identify', { body: { email: draft } });
      email = r.email; draft = ''; sessionStorage.setItem('email', email); setProject(r.project);
      if (r.expired) notice = { t: 'warn', m: 'This task has expired. Please start a new upload.' };
    }),
    newproject: () => run(async () => setProject((await api('POST', '/api/projects', { body: {} })).project)),
    newOther: () => run(async () => { const rendering = project?.task?.videoRendering === 'pending'; setProject((await api('POST', '/api/projects', { body: { replace: true } })).project); pending = {}; if (rendering) notice = { t: 'ok', m: 'Your previous video keeps rendering in the background. When it finishes you will find it under “Videos” at the top.' }; }),
    uploadAudio: () => run(async () => {
      const f = $('#audioFile').files[0]; if (!f) throw new Error('Choose an audio file first.');
      const bar = $('#upbar'); bar.style.display = ''; pending.errShown = false;
      setProject((await api('PUT', `/api/projects/${id}/audio?filename=${encodeURIComponent(f.name)}`, { raw: f, headers: { 'content-type': 'application/octet-stream' }, onProgress: (x) => { bar.firstElementChild.style.width = Math.round(x * 100) + '%'; } })).project);
      if (project.audio.size !== f.size) throw new Error(`Upload incomplete: the server stored ${project.audio.size} of ${f.size} bytes. Please upload again.`);
    }),
    retryDuration: () => run(async () => { pending.errShown = false; setProject((await api('POST', `/api/projects/${id}/audio/retry`)).project); }),
    audioDone: () => run(async () => setProject((await api('POST', `/api/projects/${id}/audio/done`)).project)),
    transcribe: () => run(async () => setProject((await api('POST', `/api/projects/${id}/transcribe`)).project)),
    pickDocs: () => { const fs = [...$('#docFiles').files]; if (!fs.length) return; let next = guessNumber(); const used = new Set(project.batches.map((b) => b.number)); pending.docs = fs.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true })).map((file) => { const m = /(\d+)/.exec(file.name); let num = m && !used.has(Number(m[1])) ? Number(m[1]) : null; if (num === null) { while (used.has(next)) next++; num = next; } used.add(num); return { file, number: num }; }); show(); },
    uploadDocs: () => run(async () => {
      document.querySelectorAll('[data-doc]').forEach((i) => { pending.docs[+i.dataset.doc].number = Number(i.value); });
      for (const d of [...pending.docs]) { setProject((await api('PUT', `/api/projects/${id}/batches?number=${d.number}&filename=${encodeURIComponent(d.file.name)}`, { raw: d.file })).project); pending.docs.shift(); }
      pending.docs = [];
    }),
    up: () => reorder(n, -1), down: () => reorder(n, 1),
    delBatch: () => run(async () => setProject((await api('DELETE', `/api/projects/${id}/batches/${n}`)).project)),
    toStage: () => run(async () => setProject((await api('POST', `/api/projects/${id}/stage`, { body: { stage: el.dataset.s } })).project)),
    pickImgs: () => { const fs = [...$('#img' + n).files]; pending['img' + n] = fs.map((file) => { const m = /^(\d+_\d+)/.exec(file.name); return { file, tag: m ? m[1] : '' }; }); show(); },
    uploadImgs: () => run(async () => {
      document.querySelectorAll(`[data-img-n="${n}"]`).forEach((i) => { pending['img' + n][+i.dataset.i].tag = i.value.trim(); });
      for (const d of [...pending['img' + n]]) { setProject((await api('PUT', `/api/projects/${id}/images?tag=${encodeURIComponent(d.tag)}&filename=${encodeURIComponent(d.file.name)}`, { raw: d.file })).project); pending['img' + n].shift(); }
    }),
    delImg: () => run(async () => setProject((await api('DELETE', `/api/projects/${id}/images/${el.dataset.id}`)).project)),
    confirmImgs: () => run(async () => { setProject((await api('POST', `/api/projects/${id}/batches/${n}/confirm-images`)).project); notice = { t: 'ok', m: `Batch ${n} images confirmed.` }; }),
    sync: () => run(async () => setProject((await api('POST', `/api/projects/${id}/sync`)).project)),
    resolve: () => run(async () => setProject((await api('POST', `/api/projects/${id}/sync/resolve`, { body: { kind: el.dataset.k, id: el.dataset.k === 'batch' ? Number(el.dataset.id) : el.dataset.id, wordIndex: Number(el.dataset.w) } })).project)),
    render: () => run(async () => setProject((await api('POST', `/api/projects/${id}/render`)).project)),
    retranscribe: () => { if (confirm('Transcribe the audio again? Synchronization will be redone afterwards (your batches and images are kept).')) run(async () => setProject((await api('POST', `/api/projects/${id}/transcribe?force=1`)).project)); },
    dlBatchAudio: () => run(() => { const f = audioFmt || project.batchAudioFormat || 'mp3', stem = (project.batches.find((b) => b.number === n)?.filename || `batch_${n}`).replace(/\.[^.]+$/, ''); return downloadFile(`/api/projects/${id}/batches/${n}/audio?format=${f}`, `${stem}_audio.${f}`); }),
    dlTranscript: () => run(() => saveBlob(`/api/projects/${id}/transcript-text`, 'transcript.txt')),
    dlTranscriptTs: () => run(() => saveBlob(`/api/projects/${id}/transcript-text?timestamps=1`, 'transcript_with_timestamps.txt')),
    download: () => run(() => downloadFile(`/api/projects/${id}/download`, 'video.mp4')),
  }[a];
  act?.();
});
async function saveBlob(path, name) { const b = await api('GET', path, { blob: true }); const u = URL.createObjectURL(b); const l = document.createElement('a'); l.href = u; l.download = name; l.click(); setTimeout(() => URL.revokeObjectURL(u), 10000); }
function reorder(n, d) { run(async () => { const o = project.batchOrder.slice(), i = o.indexOf(n), j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; setProject((await api('POST', `/api/projects/${project.id}/batches/order`, { body: { order: o } })).project); }); }
document.addEventListener('change', (e) => { if (e.target.id === 'audioFmt') audioFmt = e.target.value; });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'email') document.querySelector('[data-a=identify]')?.click(); });

// Returning visitor in the same tab: restore through the same identify flow (so expiry rules apply).
(async () => { if (email) { try { const r = await api('POST', '/api/users/identify', { body: { email } }); setProject(r.project); if (r.expired) notice = { t: 'warn', m: 'This task has expired. Please start a new upload.' }; } catch { email = ''; } } show(); })();

// Build stamp: shows which code is running, and warns if this page is older than the server (stale cache).
fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
  const el = document.getElementById('build'); if (!el) return;
  el.textContent = `Build ${v.build}${v.commit ? ' · ' + v.commit : ''}`;
  if (CLIENT_BUILD !== v.build) { el.innerHTML = `<b style="color:var(--err)">This page is out of date (page ${esc(CLIENT_BUILD)}, server ${esc(v.build)}). Press Ctrl+Shift+R to reload.</b>`; }
}).catch(() => { const el = document.getElementById('build'); if (el) el.textContent = 'Build unknown (server version endpoint not found: the server code is old)'; });
