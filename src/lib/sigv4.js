import { createHash, createHmac } from 'node:crypto';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); // RFC 3986, as SigV4 requires
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Short-lived presigned GET URL (AWS Signature V4, query-string form) for S3-compatible storage such as Cloudflare R2.
 * The browser downloads straight from the storage provider, so the file never passes through this server's bandwidth.
 * pathStyle=true  -> https://host/<bucket>/<key>   (R2 account endpoint)     pathStyle=false -> https://host/<key> (bucket already in the host)
 */
export function presignGetUrl({ endpoint, bucket, key, accessKeyId, secretAccessKey, region = 'auto', expiresSeconds = 600, now = new Date(), query = {}, pathStyle = true }) {
  const u = new URL(endpoint);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const uriPath = (pathStyle ? `/${bucket}/${key}` : `/${key}`).split('/').map(enc).join('/');
  const params = { ...query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expiresSeconds), 'X-Amz-SignedHeaders': 'host' };
  const canonicalQuery = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
  const canonicalRequest = ['GET', uriPath, canonicalQuery, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `${u.protocol}//${u.host}${uriPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
