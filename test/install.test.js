import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp } from './helpers.js';
import { BUILD } from '../src/version.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const verify = (root) => spawnSync(process.execPath, ['scripts/verify-install.mjs'], { cwd: ROOT, env: { ...process.env, VERIFY_ROOT: root }, encoding: 'utf8' });
const copy = () => { const d = mkdtempSync(path.join(tmpdir(), 'inst-')); cpSync(ROOT, d, { recursive: true, filter: (s) => !/node_modules|\.git$|\.local-data/.test(s) }); return d; };

test('/api/version reports the build, and the page is served with the same build stamped into its script URLs', async () => {
  const s = await startApp();
  try {
    const v = await (await fetch(s.base + '/api/version')).json(); assert.equal(v.build, BUILD);
    const html = await (await fetch(s.base + '/')).text();
    assert.ok(!html.includes('__BUILD__')); assert.ok(html.includes(`/client.js?v=${BUILD}`)); assert.ok(html.includes('id="build"'));
  } finally { await s.close(); }
});
test('verify-install passes on a complete project', () => { const r = verify(ROOT); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /verify-install OK/); });
test('verify-install names a missing file', () => {
  const d = copy(); try { rmSync(path.join(d, 'src/domain/matcher.js')); const r = verify(d); assert.equal(r.status, 1); assert.match(r.stderr, /MISSING FILE: src\/domain\/matcher\.js/); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('verify-install catches the browser script uploaded over src/app.js (and the reverse)', () => {
  let d = copy(); try { writeFileSync(path.join(d, 'src/app.js'), readFileSync(path.join(ROOT, 'public/client.js'))); const r = verify(d); assert.equal(r.status, 1); assert.match(r.stderr, /src\/app\.js is the BROWSER script/); } finally { rmSync(d, { recursive: true, force: true }); }
  d = copy(); try { writeFileSync(path.join(d, 'public/client.js'), readFileSync(path.join(ROOT, 'src/app.js'))); const r = verify(d); assert.equal(r.status, 1); assert.match(r.stderr, /public\/client\.js is the SERVER file/); } finally { rmSync(d, { recursive: true, force: true }); }
});
test('verify-install catches an old index.html that still loads /app.js, and warns about a stale public/app.js', () => {
  const d = copy(); try {
    writeFileSync(path.join(d, 'public/index.html'), '<script src="/app.js" type="module"></script>'); writeFileSync(path.join(d, 'public/app.js'), 'const STAGES = [];');
    const r = verify(d); assert.equal(r.status, 1); assert.match(r.stderr, /does not load \/client\.js/); assert.match(r.stdout, /warning: public\/app\.js is an old leftover/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
