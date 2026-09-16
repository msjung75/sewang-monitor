// CI reads the government source using its existing encrypted secret.
// Browser API access remains authenticated; no user cookie or secret in URLs/logs.
import { collectPermits } from '../lib/permit-source.mjs';
try{
  const data=await collectPermits(Object.fromEntries(new URLSearchParams(process.argv[2]||'')),process.env.DATA_GO_KR_KEY);
  if(data.capped)throw new Error('collection_page_limit');
  process.stdout.write(JSON.stringify(data));
}catch(error){
  const reason=['government_key_missing','government_key_invalid','collection_page_limit','upstream_request_failed','upstream_invalid_response','upstream_incomplete_page'].includes(error.message)?error.message:'collection_failed';
  console.error(reason+': previous data preserved. Check the configured government credential and provider availability.');
  process.exitCode=1;
}
