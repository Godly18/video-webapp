import fs from 'node:fs';
import { mkdir, copyFile, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Disk-backed storage for local development and tests ONLY (refused in production by config). */
export class LocalStorage {
  constructor(dir) { this.dir = dir; }
  _p(key) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir) + path.sep)) throw new Error('Invalid key');
    return p;
  }
  async putFile(key, filePath) { const p = this._p(key); await mkdir(path.dirname(p), { recursive: true }); await copyFile(filePath, p); }
  async putBuffer(key, buf) { const p = this._p(key); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, buf); }
  async getBuffer(key) { return readFile(this._p(key)); }
  async downloadTo(key, dest) { await copyFile(this._p(key), dest); }
  async openStream(key) { const p = this._p(key); const s = await stat(p); return { stream: fs.createReadStream(p), size: s.size }; }
  async exists(key) { try { await stat(this._p(key)); return true; } catch { return false; } }
  async delete(key) { await rm(this._p(key), { force: true }); }
  async listPrefix(prefix) {
    const base = this._p(prefix.replace(/\/$/, ''));
    const out = [];
    const walk = async (d) => { let ents; try { ents = await readdir(d, { withFileTypes: true }); } catch { return; } for (const e of ents) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else out.push(path.relative(path.resolve(this.dir), f).split(path.sep).join('/')); } };
    await walk(base); return out;
  }
  async deletePrefix(prefix) { const keys = await this.listPrefix(prefix); for (const k of keys) await this.delete(k); return keys.length; }
}
