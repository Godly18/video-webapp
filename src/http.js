import fs from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './lib/errors.js';

export function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}
export async function readBody(req, maxBytes) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > maxBytes) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
export async function readJson(req, maxBytes = 64 * 1024) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; } catch { throw new AppError(400, 'BAD_JSON', 'Request body must be valid JSON.'); }
}
/** Streams the request body to disk with a hard size cap (no multipart parser needed: the client PUTs the raw file). */
export async function receiveToFile(req, dest, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) { req.resume(); throw new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`); }
  const out = fs.createWriteStream(dest);
  let n = 0;
  try {
    for await (const c of req) {
      n += c.length;
      if (n > maxBytes) throw new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${Math.round(maxBytes / 1048576)} MB limit.`);
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((res, rej) => { out.end((e) => (e ? rej(e) : res())); });
  } catch (e) { out.destroy(); throw e; }
  if (n === 0) throw new AppError(400, 'EMPTY_FILE', 'The uploaded file is empty.');
  if (Number.isFinite(declared) && declared > 0 && n !== declared) throw new AppError(400, 'UPLOAD_INCOMPLETE', 'The upload was cut off before the whole file arrived. Please upload it again.');
  return n;
}
export class RateLimiter {
  constructor(limit, windowMs, now = Date.now) { this.limit = limit; this.windowMs = windowMs; this.now = now; this.hits = new Map(); }
  allow(key) {
    const t = this.now(); const e = this.hits.get(key);
    if (!e || t - e.start > this.windowMs) { this.hits.set(key, { start: t, n: 1 }); if (this.hits.size > 5000) this.prune(t); return true; }
    return ++e.n <= this.limit;
  }
  prune(t) { for (const [k, e] of this.hits) if (t - e.start > this.windowMs) this.hits.delete(k); }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
export async function serveIndex(res, publicDir, build) {
  try {
    const html = (await readFile(path.join(publicDir, 'index.html'), 'utf8')).replaceAll('__BUILD__', build), buf = Buffer.from(html);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' }); res.end(buf); return true;
  } catch { return false; }
}
export async function serveStatic(res, publicDir, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.resolve(publicDir, '.' + decodeURIComponent(rel));
  if (!file.startsWith(path.resolve(publicDir) + path.sep)) return false;
  try {
    const s = await stat(file); if (!s.isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': s.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res); return true;
  } catch { return false; }
}
