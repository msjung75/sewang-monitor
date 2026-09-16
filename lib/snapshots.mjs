import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const CHUNK_BYTES=1_000_000;
const MAX_BYTES=100_000_000;
// Only retain the last large immutable deployment snapshot, not user responses.
let cached;
export function snapshotChunks(raw, query={}) {
  const input=Buffer.from(raw);
  if(input.length>MAX_BYTES)return {status:503,json:{error:'snapshot_too_large'}};
  const encoding=query.encoding==='gzip'?'gzip':'identity';
  const revision=createHash('sha256').update(input).digest('hex');
  if(query.part!==undefined && (query.revision!==revision || !/^\d{1,3}$/.test(String(query.part)))){
    return {status:query.revision!==revision?409:400,json:{error:query.revision!==revision?'snapshot_changed':'invalid_part'}};
  }
  if(input.length<=2_000_000 && query.part===undefined)return {status:200,body:input};
  if(!cached || cached.revision!==revision || cached.encoding!==encoding){
    cached={revision,encoding,body:encoding==='gzip'?gzipSync(input):input};
  }
  const body=cached.body,parts=Math.ceil(body.length/CHUNK_BYTES);
  if(query.part!==undefined){
    const part=Number(query.part);
    if(part>=parts)return {status:400,json:{error:'invalid_part'}};
    return {status:200,json:{revision,part,data:body.subarray(part*CHUNK_BYTES,(part+1)*CHUNK_BYTES).toString('base64')}};
  }
  return {status:200,json:{_sewangSnapshot:1,revision,encoding,parts,bytes:body.length,decodedBytes:input.length}};
}

// Large permit snapshots exceed the Functions payload limit uncompressed.
// Reserve room for the binary response envelope as well as HTTP headers.
export function snapshotResponse(raw, acceptEncoding = '') {
  const input = Buffer.from(raw);
  const gzip = String(acceptEncoding).split(',').some(value => /^\s*gzip\s*(;|$)/i.test(value) && !/;\s*q=0(?:\.0*)?\s*$/i.test(value));
  const body = gzip ? gzipSync(input) : input;
  if (body.length > 3_300_000) return { error: gzip ? 'snapshot_too_large' : 'gzip_required', status: gzip ? 503 : 406 };
  return { body, encoding: gzip ? 'gzip' : null };
}
