const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto,randomBytes}=require('node:crypto');
async function client(raw,{encoding='gzip',failPart,changeRevision,corrupt}={}){
  const {snapshotChunks}=await import('../lib/snapshots.mjs');
  let calls=0,manifests=0;const states=[];
  const context={URL,AbortController,setTimeout,clearTimeout,Uint8Array,TextDecoder,Blob,Response,atob,crypto:webcrypto,DecompressionStream:encoding==='gzip'?DecompressionStream:undefined,location:{origin:'https://fixture.invalid'},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},document:{dispatchEvent:e=>states.push(e.detail)}};
  context.window=context;
  context.fetch=async(url,options)=>{
    assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');calls++;
    const q=Object.fromEntries(new URL(url).searchParams);if(q.part===undefined)manifests++;
    if(q.part!==undefined && failPart)return {ok:false,status:503};
    if(q.part!==undefined && changeRevision && manifests===1)return {ok:false,status:409};
    const output=snapshotChunks(raw,q);
    if(corrupt && output.json?.data)output.json.data=Buffer.from('bad data').toString('base64');
    return {ok:output.status===200,status:output.status,json:async()=>output.json||JSON.parse(output.body.toString())};
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync('assets/data-client.js','utf8'),context);
  context.setAppDataUser({id:'123',role:'staff'});
  return {context,states,counts:()=>({calls,manifests})};
}
const raw=JSON.stringify({label:'서울 · 가나다',records:randomBytes(2300000).toString('base64')});
test('large Korean snapshots load as bounded JSON parts without relying on Accept-Encoding',async()=>{
  const {context,counts}=await client(raw);
  const data=await (await context.fetchAppData('/data/ytd_2026_summary.json')).json();
  assert.equal(JSON.stringify(data),raw);assert.ok(counts().calls>=3);
});
test('browsers without DecompressionStream use verified UTF-8 parts',async()=>{
  const {context}=await client(raw,{encoding:'identity'});
  assert.equal(JSON.stringify(await (await context.fetchAppData('/data/ytd_2026_summary.json')).json()),raw);
});
test('partial failures do not become empty records and deployment revision changes retry once',async()=>{
  const failed=await client(raw,{failPart:true});
  await assert.rejects(failed.context.fetchAppData('/data/ytd_2026_summary.json'));
  assert.equal(failed.states.at(-1).state,'error');
  const changed=await client(raw,{changeRevision:true});
  assert.equal(JSON.stringify(await (await changed.context.fetchAppData('/data/ytd_2026_summary.json')).json()),raw);
  assert.equal(changed.counts().manifests,2);
});
test('truncated or corrupt parts are rejected before any snapshot is used',async()=>{
  const {context}=await client(raw,{corrupt:true});
  await assert.rejects(context.fetchAppData('/data/ytd_2026_summary.json'));
});
test('real scheduled YTD and permit files fit the transfer protocol without changing any source data',async()=>{
  const {snapshotChunks}=await import('../lib/snapshots.mjs');
  for(const file of ['ytd_2026_summary.json','trend30_all.json']){
    const data=fs.readFileSync('data/'+file,'utf8'),out=snapshotChunks(data,{encoding:'gzip'});
    assert.equal(out.status,200);
    if(out.json?._sewangSnapshot){for(let part=0;part<out.json.parts;part++){
      const result=snapshotChunks(data,{encoding:'gzip',part:String(part),revision:out.json.revision});
      assert.equal(result.status,200);assert.ok(Buffer.byteLength(JSON.stringify(result.json))<1500000);
    }}
    const {context}=await client(data);
    assert.equal(JSON.stringify(await (await context.fetchAppData('/data/'+file)).json()),JSON.stringify(JSON.parse(data)));
  }
});
