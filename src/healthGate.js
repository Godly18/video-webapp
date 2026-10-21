/**
 * Runs in its OWN worker thread and owns the public port.
 *  - GET/HEAD /health is answered right here, never touching the main thread, so a busy/stalled main event loop cannot fail Render's health check.
 *  - Everything else is streamed through to the app server listening on 127.0.0.1 (internal port).
 * Limit (honest): this isolates /health from the app's event loop. It cannot help if the whole container is out of CPU/RAM, which is why
 * FFmpeg is also run at lowest priority with limited threads (see services/ffmpeg.js).
 */
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const { port, host, target } = workerData;
const OK = Buffer.from('{"status":"ok"}');

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/health' || path === '/health/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': OK.length, 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : OK); req.resume(); return;
  }
  const headers = { ...req.headers, 'x-forwarded-for': req.headers['x-forwarded-for'] || req.socket.remoteAddress };
  const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The server is busy. Please retry.' } })); } else res.destroy();
  });
  res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
});
server.requestTimeout = 0; server.headersTimeout = 60_000; server.keepAliveTimeout = 65_000;
server.on('error', (e) => parentPort.postMessage({ listening: false, error: e.message }));
server.listen(port, host, () => parentPort.postMessage({ listening: true, port: server.address().port }));
