/** Image tags are "<batch>_<image>". Numbering restarts in every batch: 2_1 maps to [image_1] of batch 2, never [image_2]. */
export function parseTag(tag) {
  const m = /^\s*(\d{1,4})_(\d{1,4})\s*$/.exec(String(tag ?? ''));
  if (!m) return null;
  const batch = Number(m[1]), marker = Number(m[2]);
  if (batch < 1 || marker < 1) return null;
  return { batch, marker, tag: `${batch}_${marker}` };
}

/**
 * batches: [{number, markers:[number]}]; images: [{id, tag}]; onlyBatch: restrict checks to one batch (per-batch Done button).
 * Returns {mappings, problems}. Nothing is guessed or substituted.
 */
export function buildMapping({ batches, images, onlyBatch = null }) {
  const problems = [], mappings = [];
  const byBatch = new Map(batches.map((b) => [b.number, b]));
  const seenTags = new Map();
  for (const img of images) {
    const p = parseTag(img.tag);
    if (!p) { if (onlyBatch === null) problems.push({ code: 'INVALID_TAG', tag: img.tag, imageId: img.id, message: `Image tag "${img.tag}" is not in the form <batch>_<image>, e.g. 1_1.` }); continue; }
    if (onlyBatch !== null && p.batch !== onlyBatch) continue;
    if (seenTags.has(p.tag)) { problems.push({ code: 'DUPLICATE_TAG', tag: p.tag, batch: p.batch, message: `Tag ${p.tag} is used by more than one image.` }); continue; }
    seenTags.set(p.tag, img);
    const batch = byBatch.get(p.batch);
    if (!batch) { problems.push({ code: 'UNKNOWN_BATCH', tag: p.tag, batch: p.batch, message: `Tag ${p.tag} refers to batch ${p.batch}, which has not been uploaded.` }); continue; }
    if (!batch.markers.includes(p.marker)) { problems.push({ code: 'UNMATCHED_IMAGE', tag: p.tag, batch: p.batch, marker: p.marker, message: `Tag ${p.tag} has no [image_${p.marker}] marker in batch ${p.batch}.` }); continue; }
    mappings.push({ batch: p.batch, marker: p.marker, tag: p.tag, imageId: img.id });
  }
  for (const b of batches) {
    if (onlyBatch !== null && b.number !== onlyBatch) continue;
    for (const n of b.markers) if (!seenTags.has(`${b.number}_${n}`)) problems.push({ code: 'MISSING_IMAGE', batch: b.number, marker: n, tag: `${b.number}_${n}`, message: `Batch ${b.number} marker [image_${n}] has no image (expected tag ${b.number}_${n}).` });
  }
  return { mappings, problems };
}
