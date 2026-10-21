import { createHash } from 'node:crypto';

/** Single normalisation used everywhere: trim + NFKC + lowercase. Returns null if invalid. */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().normalize('NFKC').toLowerCase();
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(e)) return null;
  return e;
}
/** Stable Firestore document id: SHA-256 hex of the normalised email. */
export function userIdFor(normalizedEmail) {
  return createHash('sha256').update(normalizedEmail, 'utf8').digest('hex');
}
