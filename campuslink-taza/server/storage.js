import './env.js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';

const extensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.txt']);

export function resourceObjectKey({ filiereId, semester, moduleId, filename, prefix = 'resources' }) {
  const extension = extname(filename || '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(filiereId || '') || !Number.isInteger(Number(semester)) || Number(semester) < 1 || Number(semester) > 6 || !Number.isSafeInteger(Number(moduleId)) || Number(moduleId) < 1 || !extensions.has(extension) || !['resources', 'resource-versions'].includes(prefix)) {
    const error = new Error('Classification du fichier invalide.');
    error.status = 400;
    throw error;
  }
  return `${prefix}/${filiereId}/${Number(semester)}/${Number(moduleId)}/${randomUUID()}${extension}`;
}

function storageError(cause) {
  if (cause?.$metadata?.httpStatusCode === 416 || cause?.name === 'InvalidRange') {
    const error = new Error('Plage de fichier invalide.');
    error.status = 416;
    return error;
  }
  const missing = cause?.$metadata?.httpStatusCode === 404 || ['NoSuchKey', 'NotFound'].includes(cause?.name);
  const error = new Error(missing ? 'Fichier indisponible. Signalez-le à l’administration.' : 'Le stockage des fichiers est temporairement indisponible. Réessayez.');
  error.status = missing ? 404 : 502;
  // Do not retain/log provider errors: their diagnostics may contain credentials.
  return error;
}

export function createStorage(env = process.env) {
  const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_REGION'];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`Missing server configuration: ${missing.join(', ')}`);
  let endpoint;
  try { endpoint = new URL(env.R2_ENDPOINT); } catch { throw new Error('R2_ENDPOINT must be a valid HTTPS endpoint.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('R2_ENDPOINT must be a valid HTTPS endpoint.');
  if (env.R2_BUCKET_NAME !== 'uploads') throw new Error('R2_BUCKET_NAME must use the configured uploads bucket.');
  const bucket = env.R2_BUCKET_NAME;
  const client = new S3Client({
    endpoint: endpoint.href,
    region: env.R2_REGION,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
    maxAttempts: 3,
    // Cloudflare R2 supports ordinary S3 operations without optional AWS checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const send = async command => {
    try { return await client.send(command); } catch (error) { throw storageError(error); }
  };
  return {
    async put(key, buffer, mime) {
      await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentLength: buffer.length, ContentType: mime, CacheControl: 'private, no-store' }));
    },
    async get(key, { range } = {}) {
      const result = await send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) }));
      return { body: result.Body, contentLength: result.ContentLength, contentType: result.ContentType, contentRange: result.ContentRange, etag: result.ETag };
    },
    async head(key) {
      const result = await send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: result.ContentLength, contentType: result.ContentType, etag: result.ETag };
    },
    async delete(key) { await send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
    close() { client.destroy(); },
  };
}
