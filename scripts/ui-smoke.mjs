// Optional browser smoke test: drives the real UI with Playwright against an in-process app (fake Gemini, real FFmpeg).
// Run: npm i -D playwright && npx playwright install chromium && node scripts/ui-smoke.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, makeFixtures } from '../test/helpers.js';

const req = createRequire(import.meta.url);
let pw; try { pw = req('playwright'); } catch { pw = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'); }
const fx = makeFixtures(6);
const w = (n, t) => { const f = path.join(fx.dir, n); writeFileSync(f, t); return f; };
const b1 = w('batch_1.txt', '[image_1] alpha beta gamma delta epsilon zeta eta theta [image_2] iota kappa lambda mu nu xi omicron pi');
const b2 = w('batch_2.txt', '[image_1] rho sigma tau upsilon');
const img = (n, src) => { const f = path.join(fx.dir, n); copyFileSync(src, f); return f; };
const s = await startApp();
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, acceptDownloads: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errs.push(m.text()));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message.split('\n')[0]); await page.screenshot({ path: '/tmp/ui-fail.png' }); console.log('TEXT:', (await page.innerText('#app')).replace(/\n+/g, ' | ').slice(0, 400)); await browser.close(); await s.close(); process.exit(1); } };
const T = 30000;

await step('identify with invalid email shows an error and keeps the input', async () => {
  await page.goto(s.base); await page.fill('#email', 'nope'); await page.click('[data-a=identify]');
  await page.waitForSelector('.msg.err', { timeout: T }); if ((await page.inputValue('#email')) !== 'nope') throw new Error('typed text was wiped');
});
await step('identify with valid email -> New project', async () => { await page.fill('#email', 'peaceeneh77@gmail.com'); await page.click('[data-a=identify]'); await page.waitForSelector('[data-a=newproject]', { timeout: T }); });
await step('start project -> audio screen', async () => { await page.click('[data-a=newproject]'); await page.waitForSelector('#audioFile', { timeout: T }); });
await step('upload audio -> duration shown, Done enabled', async () => {
  await page.setInputFiles('#audioFile', fx.wav); await page.click('[data-a=uploadAudio]');
  await page.waitForSelector('text=Your audio duration is', { timeout: T }); await page.waitForSelector('[data-a=audioDone]:not([disabled])', { timeout: T });
});
await step('Done -> batches screen, transcript ready', async () => { await page.click('[data-a=audioDone]'); await page.waitForSelector('#docFiles', { timeout: T }); await page.waitForSelector('text=Transcript ready', { timeout: 15000 }); });
await step('add + upload two text batches', async () => {
  await page.setInputFiles('#docFiles', [b1, b2]); await page.click('[data-a=pickDocs]'); await page.waitForSelector('[data-doc]');
  await page.click('[data-a=uploadDocs]'); await page.waitForSelector('tr:has-text("batch_2.txt")', { timeout: T });
  if ((await page.locator('table tr').count()) !== 3) throw new Error('expected 2 batch rows');
});
await step('continue to images', async () => { await page.click('[data-a=toStage][data-s=images]'); await page.waitForSelector('#img1', { timeout: T }); });
await step('upload images with tags guessed from file names, confirm each batch', async () => {
  await page.setInputFiles('#img1', [img('1_1.png', fx.imgs.red), img('1_2.png', fx.imgs.green)]); await page.click('[data-a=pickImgs][data-n="1"]');
  await page.click('[data-a=uploadImgs][data-n="1"]'); await page.waitForSelector('img[data-img]', { timeout: T });
  await page.click('[data-a=confirmImgs][data-n="1"]'); await page.waitForSelector('text=confirmed', { timeout: T });
  await page.setInputFiles('#img2', [img('2_1.png', fx.imgs.blue)]); await page.click('[data-a=pickImgs][data-n="2"]');
  await page.click('[data-a=uploadImgs][data-n="2"]'); await page.waitForFunction(() => document.querySelectorAll('img[data-img]').length === 3, null, { timeout: T });
  await page.click('[data-a=confirmImgs][data-n="2"]'); await page.waitForFunction(() => document.querySelectorAll('.msg.ok').length >= 2 || document.body.innerText.includes('confirmed'), null, { timeout: T });
  await page.waitForSelector('[data-a=toStage][data-s=review]:not([disabled])', { timeout: T });
});
await step('review: synchronization table with correct times', async () => {
  await page.click('[data-a=toStage][data-s=review]'); await page.waitForSelector('text=Image timeline', { timeout: 30000 });
  const txt = await page.innerText('#app'); for (const want of ['1_1', '1_2', '2_1', '00:00:04.75', '00:00:02.40']) if (!txt.includes(want)) throw new Error('missing ' + want);
  await page.waitForSelector('[data-a=render]:not([disabled])', { timeout: T });
});
await step('transcript download buttons sit above the Batches header and download the .txt', async () => {
  const order = await page.evaluate(() => { const b = document.querySelector('[data-a=dlTranscript]'), h = [...document.querySelectorAll('h3')].find((x) => x.textContent === 'Batches'); return !!b && !!h && !!(b.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING); });
  if (!order) throw new Error('download button is not above the Batches header');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.click('[data-a=dlTranscript]')]);
  const f = '/tmp/ui-transcript.txt'; await dl.saveAs(f); const txt = (await import('node:fs')).readFileSync(f, 'utf8');
  if (!txt.startsWith('alpha beta gamma')) throw new Error('unexpected transcript: ' + txt.slice(0, 60));
});
await step('render -> ready -> download MP4', async () => {
  await page.click('[data-a=render]'); await page.waitForSelector('text=Your video is ready', { timeout: 90000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.click('[data-a=download]')]);
  const f = '/tmp/ui-video.mp4'; await dl.saveAs(f); const out = execSync(`ffprobe -v error -show_entries stream=codec_name -of csv=p=0 ${f}`).toString(); if (!/h264/.test(out) || !/aac/.test(out)) throw new Error('bad output: ' + out);
});
await step('Exit then same email restores the finished project', async () => {
  await page.click('[data-a=exit]'); await page.fill('#email', 'PEACEENEH77@gmail.com '); await page.click('[data-a=identify]'); await page.waitForSelector('text=Your video is ready', { timeout: T });
});
console.log(errs.length ? 'BROWSER ERRORS: ' + JSON.stringify(errs) : 'no browser console errors');
await browser.close(); await s.close();
