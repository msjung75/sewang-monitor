const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const response=(items=[],total=items.length)=>({ok:true,text:async()=>JSON.stringify({response:{header:{resultCode:'00'},body:{totalCount:total,items:{item:items}}}})});
test('encoded and decoded government credentials produce the same serviceKey without double encoding',async()=>{
 const {collectPermits}=await import('../lib/permit-source.mjs');
 for(const key of ['fixture+/=','fixture%2B%2F%3D']){
  await collectPermits({region:'seoul',type:'ilban'},key,{fetcher:async url=>{assert.equal(new URL(url).searchParams.get('serviceKey'),'fixture+/=');return response();}});
 }
});
test('government transport, permission, malformed response and partial service failures never become zero results',async()=>{
 const {collectPermits}=await import('../lib/permit-source.mjs');
 for(const fetcher of [async()=>({ok:false,status:403}),async()=>({ok:true,text:async()=>'<error>'}),async()=>({ok:true,text:async()=>JSON.stringify({error:'denied'})}),async()=>response([],1)]){
  await assert.rejects(collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher}));
 }
 let calls=0;await assert.rejects(collectPermits({region:'seoul',type:'all'},'fixture',{fetcher:async()=>++calls===2?{ok:false}:response()}));
});
test('valid empty government results and pagination are distinct from failure',async()=>{
 const {collectPermits}=await import('../lib/permit-source.mjs');
 assert.equal((await collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher:async()=>response()})).count,0);
 const rows=Array.from({length:100},(_,i)=>({MNG_NO:String(i),BPLC_NM:'가상 주막',LCPMT_YMD:'20260901'}));
 const capped=await collectPermits({region:'seoul',type:'ilban',maxPages:'1'},'fixture',{fetcher:async()=>response(rows,101)});
 assert.equal(capped.capped,true);
 let pages=0;const all=await collectPermits({region:'seoul',type:'ilban',maxPages:'2'},'fixture',{fetcher:async()=>++pages===1?response(rows,101):response([{...rows[0],MNG_NO:'100'}],101)});
 assert.equal(all.count,101);assert.equal(all.capped,false);
});
function runCollector(script,mode){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sewang-collector-'));
 fs.mkdirSync(path.join(root,'data/ytd_2026'),{recursive:true});fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'bin'));
 const previous='{"at":"last-success","stores":[{"id":"keep-me"}]}';
 fs.writeFileSync(path.join(root,'data/trend30_all.json'),previous);fs.writeFileSync(path.join(root,'data/ytd_2026/202609.json'),previous);
 fs.copyFileSync('scripts/permit_client.py',path.join(root,'scripts/permit_client.py'));
 fs.writeFileSync(path.join(root,'bin/sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 fs.writeFileSync(path.join(root,'bin/node'),`#!/usr/bin/env python3
import sys,os,json,urllib.parse
q=urllib.parse.parse_qs(sys.argv[-1]);region=q['region'][0]
if os.environ['TEST_COLLECTION_MODE']=='failure' and region=='busan':
 print(json.dumps({'error':'login_required'}));sys.exit(1)
rows=[] if region=='jeju' else [{'id':region,'name':'가상 주막','permitDate':'20260910','status':'영업'}]
print(json.dumps({'items':rows,'count':len(rows),'capped':False}))
`,{mode:0o755});
 const result=spawnSync('bash',[path.resolve(script)],{cwd:root,env:{...process.env,PATH:path.join(root,'bin')+':'+process.env.PATH,TEST_COLLECTION_MODE:mode},encoding:'utf8'});
 return {root,result,previous,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('one failed region fails both scheduled collectors and preserves exact existing snapshots',()=>{
 for(const script of ['scripts/nightly-fetch.sh','scripts/fetch-ytd-range.sh']){
  const run=runCollector(script,'failure');
  try{assert.notEqual(run.result.status,0);for(const file of ['data/trend30_all.json','data/ytd_2026/202609.json'])assert.equal(fs.readFileSync(path.join(run.root,file),'utf8'),run.previous);}finally{run.close();}
 }
});
test('complete region collection publishes valid records, accepting a genuinely empty region',()=>{
 const run=runCollector('scripts/nightly-fetch.sh','success');
 try{assert.equal(run.result.status,0,run.result.stderr);const d=JSON.parse(fs.readFileSync(path.join(run.root,'data/trend30_all.json')));assert.equal(d.count,16);assert.deepEqual(d.failures,[]);}finally{run.close();}
});
