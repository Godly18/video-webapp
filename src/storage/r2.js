import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/** Cloudflare R2 via the S3-compatible API. Keep the bucket PRIVATE; media is streamed through the server. */
export async function createR2Storage(cfg) {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  const Bucket = cfg.r2.bucket;
  const s3 = new S3Client({
    region: 'auto', endpoint: cfg.r2.endpoint,
    credentials: { accessKeyId: cfg.r2.accessKeyId, secretAccessKey: cfg.r2.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', // R2 does not accept the SDK's newer default CRC checksums on streamed bodies
  });
  const get = (Key) => s3.send(new GetObjectCommand({ Bucket, Key }));
  const api = {
    async putFile(key, filePath, { contentType } = {}) {
      const { size } = await stat(filePath);
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: fs.createReadStream(filePath), ContentLength: size, ContentType: contentType }));
    },
    async putBuffer(key, buf, { contentType } = {}) { await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: buf, ContentType: contentType })); },
    async getBuffer(key) { const r = await get(key); return Buffer.from(await r.Body.transformToByteArray()); },
    async downloadTo(key, dest) { const r = await get(key); await pipeline(r.Body, fs.createWriteStream(dest)); },
    async openStream(key) { const r = await get(key); return { stream: r.Body, size: r.ContentLength }; },
    async exists(key) { try { await s3.send(new HeadObjectCommand({ Bucket, Key: key })); return true; } catch { return false; } },
    async delete(key) { await s3.send(new DeleteObjectCommand({ Bucket, Key: key })); },
    async listPrefix(prefix) {
      const keys = []; let ContinuationToken;
      do { const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken })); (r.Contents || []).forEach((o) => keys.push(o.Key)); ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined; } while (ContinuationToken);
      return keys;
    },
    async deletePrefix(prefix) {
      const keys = await api.listPrefix(prefix);
      for (let i = 0; i < keys.length; i += 1000) {
        const r = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
        if (r.Errors?.length) throw new Error(`R2 delete failed for ${r.Errors.length} objects`);
      }
      return keys.length;
    },
  };
  return api;
}
