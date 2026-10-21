import { randomBytes } from 'node:crypto';
/** Ids use only [a-z0-9_] so they are safe as Firestore field-path segments and R2 key parts. */
export const newId = (prefix) => `${prefix}_${randomBytes(9).toString('hex')}`;
export function safeFilename(name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop().normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80);
  return base || fallback;
}
