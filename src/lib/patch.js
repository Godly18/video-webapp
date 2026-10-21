/** Dotted-path patches (Firestore update semantics) shared by every DB driver. */
export const DELETE = Symbol('delete');
export function applyPatch(doc, patch) {
  const out = structuredClone(doc);
  for (const [path, val] of Object.entries(patch)) {
    const parts = path.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (val === DELETE) delete cur[last];
    else cur[last] = structuredClone(val);
  }
  return out;
}
