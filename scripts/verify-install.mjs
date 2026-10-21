// Fails the build (clearly) if the project files are incomplete or in the wrong place.  Run: node scripts/verify-install.mjs
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.VERIFY_ROOT || path.resolve(import.meta.dirname, '..');
const need = [
  'package.json', '.github/workflows/render-job.yml',
  ...['index', 'app', 'config', 'http', 'view', 'version', 'healthGate', 'remoteRunner'].map((f) => `src/${f}.js`),
  ...['errors', 'email', 'time', 'patch', 'ids'].map((f) => `src/lib/${f}.js`),
  ...['normalize', 'markers', 'imageMapping', 'matcher', 'duration', 'taskState', 'timeline', 'renderPlanner', 'batchAudio'].map((f) => `src/domain/${f}.js`),
  ...['memory', 'firestore'].map((f) => `src/db/${f}.js`), ...['local', 'r2'].map((f) => `src/storage/${f}.js`),
  ...['ffmpeg', 'gemini', 'sync', 'githubDispatch'].map((f) => `src/services/${f}.js`), ...['service', 'handlers', 'cleanup'].map((f) => `src/jobs/${f}.js`),
  'public/index.html', 'public/client.js', 'public/style.css',
];
const problems = [], warnings = [];
for (const f of need) if (!existsSync(path.join(root, f))) problems.push(`MISSING FILE: ${f}`);
const read = (f) => (existsSync(path.join(root, f)) ? readFileSync(path.join(root, f), 'utf8') : '');
if (/^\s*const STAGES\b/.test(read('src/app.js'))) problems.push('src/app.js is the BROWSER script (it starts with "const STAGES"). The server file must start with "import http from \'node:http\'". The browser script belongs in public/client.js.');
if (read('public/client.js') && !/^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*(let|const)\s/.test(read('public/client.js')) ) warnings.push('public/client.js does not look like the browser script');
if (/import\s+http\s+from/.test(read('public/client.js'))) problems.push('public/client.js is the SERVER file. The browser script must be here; the server file belongs in src/app.js.');
if (read('public/index.html') && !/src="\/client\.js/.test(read('public/index.html'))) problems.push('public/index.html does not load /client.js (it probably still points to the old /app.js). Replace public/index.html with the new one.');
if (existsSync(path.join(root, 'public/app.js'))) warnings.push('public/app.js is an old leftover and is no longer used. You can delete it.');
if (!problems.length) {
  try {
    const m = await import(pathToFileURL(path.join(root, 'src/app.js')).href);
    if (typeof m.createApp !== 'function') problems.push('src/app.js does not export createApp: wrong file or an outdated version.');
    const v = await import(pathToFileURL(path.join(root, 'src/version.js')).href);
    if (!problems.length) console.log(`verify-install OK  build=${v.BUILD}`);
  } catch (e) { problems.push(`The server code does not load: ${e.message}`); }
}
warnings.forEach((w) => console.log('warning: ' + w));
if (problems.length) { console.error('\nverify-install FAILED:\n - ' + problems.join('\n - ') + '\n'); process.exit(1); }
