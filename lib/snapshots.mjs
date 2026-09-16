import { gzipSync } from 'node:zlib';

// Large permit snapshots exceed the Functions payload limit uncompressed.
// Reserve room for the binary response envelope as well as HTTP headers.
export function snapshotResponse(raw, acceptEncoding = '') {
  const input = Buffer.from(raw);
  const gzip = String(acceptEncoding).split(',').some(value => /^\s*gzip\s*(;|$)/i.test(value) && !/;\s*q=0(?:\.0*)?\s*$/i.test(value));
  const body = gzip ? gzipSync(input) : input;
  if (body.length > 3_300_000) return { error: gzip ? 'snapshot_too_large' : 'gzip_required', status: gzip ? 503 : 406 };
  return { body, encoding: gzip ? 'gzip' : null };
}
