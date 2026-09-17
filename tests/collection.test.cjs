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
  await assert.rejects(collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher,wait:async()=>{}}));
 }
 await assert.rejects(collectPermits({region:'seoul',type:'all'},'fixture',{fetcher:async url=>url.includes('rest_cafes')?{ok:false,status:503}:response(),wait:async()=>{}}));
});
test('temporary government failures retry, while invalid credentials fail without repeated calls',async()=>{
 const {collectPermits}=await import('../lib/permit-source.mjs');let calls=0,waits=0;
 const d=await collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher:async()=>++calls<3?{ok:false,status:503}:response(),wait:async()=>{waits++;}});
 assert.equal(d.count,0);assert.equal(calls,3);assert.equal(waits,2);
 calls=0;await assert.rejects(collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher:async()=>{calls++;return {ok:false,status:403};},wait:async()=>{throw Error('unexpected retry');}}));
 assert.equal(calls,1);
});
test('valid empty government results and pagination are distinct from failure',async()=>{
 const {collectPermits}=await import('../lib/permit-source.mjs');
 assert.equal((await collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher:async()=>response()})).count,0);
 const rows=Array.from({length:100},(_,i)=>({MNG_NO:String(i),BPLC_NM:'가상 주막',LCPMT_YMD:'20260901'}));
 const capped=await collectPermits({region:'seoul',type:'ilban',maxPages:'1'},'fixture',{fetcher:async()=>response(rows,101)});
 assert.equal(capped.capped,true);
 let pages=0;const all=await collectPermits({region:'seoul',type:'ilban',maxPages:'2'},'fixture',{fetcher:async()=>++pages===1?response(rows,101):response([{...rows[0],MNG_NO:'100'}],101)});
 assert.equal(all.count,101);assert.equal(all.capped,false);
 await assert.rejects(collectPermits({region:'seoul',type:'ilban'},'fixture',{fetcher:async()=>response(rows.slice(0,10),101)}),/upstream_incomplete_page/);
});
test('CI transport restricts destinations and redirects without exposing request credentials',()=>{
 const script=`
import contextlib, io, json, runpy, urllib.request
scope=runpy.run_path('scripts/government-transport.py')
for url in ['http://apis.data.go.kr/1741000/test?serviceKey=SECRET', 'https://example.com/1741000/test?serviceKey=SECRET', 'https://apis.data.go.kr:444/1741000/test?serviceKey=SECRET']:
 with contextlib.redirect_stdin(io.StringIO(json.dumps({'url':url}))) if hasattr(contextlib,'redirect_stdin') else contextlib.nullcontext():
  import sys
  sys.stdin=io.StringIO(json.dumps({'url':url}))
  try: scope['main'](); raise AssertionError('accepted invalid destination')
  except ValueError as error: assert str(error)=='invalid_target'
assert scope['NoRedirect']().redirect_request(None,None,302,'',{},'https://example.com') is None
`;
 const r=spawnSync('python3',['-c',script],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
test('CI transport sends credentials through stdin, sanitizes failures and terminates on timeout',async()=>{
 const {governmentFetch}=await import('../scripts/government-transport.mjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sewang-transport-'));const previous=process.env.PATH;
 try{
  fs.writeFileSync(path.join(root,'python3'),`#!/usr/bin/env node
const fs=require('fs');
if(process.argv.some(x=>x.includes('SECRET'))) process.exit(2);
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const url=JSON.parse(input).url;
 if(url.includes('delay')){setTimeout(()=>process.exit(0),60000);return;}
 if(url.includes('failure')){console.log(JSON.stringify({error:'SECRET request URL'}));return;}
 console.log(JSON.stringify({status:200,body:JSON.stringify({keyReceived:new URL(url).searchParams.get('serviceKey')==='SECRET'})}));
});
`,{mode:0o755});
  process.env.PATH=root+':'+previous;
  const r=await governmentFetch('https://apis.data.go.kr/1741000/test?serviceKey=SECRET');
  assert.equal(r.status,200);assert.equal(JSON.parse(await r.text()).keyReceived,true);
  await assert.rejects(governmentFetch('https://apis.data.go.kr/1741000/failure?serviceKey=SECRET'),/^Error: upstream_connection_failed$/);
  const controller=new AbortController();
  const request=governmentFetch('https://apis.data.go.kr/1741000/delay?serviceKey=SECRET',{signal:controller.signal});
  controller.abort();await assert.rejects(request,/upstream_timeout/);
 }finally{process.env.PATH=previous;fs.rmSync(root,{recursive:true,force:true});}
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
