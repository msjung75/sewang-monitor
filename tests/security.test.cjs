const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let S, SignJWT;
before(async () => {
  S = await import('../lib/security.mjs');
  ({SignJWT} = await import('jose'));
  process.env.JWT_SECRET = 'fixture-only-'.repeat(4);
  process.env.GITHUB_TOKEN = 'fixture-only';
  process.env.ADMIN_KAKAO_ID = '';
});
function res() { return {code:200, headers:{}, setHeader(k,v){this.headers[k]=v;}, status(c){this.code=c;return this;}, json(body){this.body=body;return this;}, send(body){this.body=body;return this;}, redirect(code,url){this.code=code;this.url=url;}}; }
function list(users = [{id:'123',role:'staff'}], blocked = []) {return async () => ({ok:true,json:async()=>({content:Buffer.from(JSON.stringify({users,blocked})).toString('base64')})});}
async function token(role='admin', options={}) {return new SignJWT({id:'123',r:role,n:'fixture'}).setProtectedHeader({alg:'HS256'}).setIssuer(S.SESSION_OPTIONS.issuer).setAudience(options.audience || S.SESSION_OPTIONS.audience).setIssuedAt().setExpirationTime('1h').sign(S.sessionKey());}
async function request(extra={}) {return {method:'GET',query:{},headers:{cookie:'sewang_session='+await token()},...extra};}

test('missing, short and former development secrets fail closed',()=>{
  const saved=process.env.JWT_SECRET;
  try {for(const value of ['', 'short', 'dev-secret-change-me-please']){process.env.JWT_SECRET=value;assert.throws(()=>S.sessionKey());}}finally{process.env.JWT_SECRET=saved;}
});
test('anonymous API requests do not contact any upstream service',async()=>{
  const saved=global.fetch;global.fetch=()=>{throw Error('unexpected network');};
  try {for(const file of fs.readdirSync('api').filter(x=>x.endsWith('.js')&&x!=='_github.js')){
    const handler=(await import('../api/'+file)).default;const out=res();
    await handler({method:'GET',query:{},headers:{}},out);assert.equal(out.code,401,file);assert.match(out.headers['Cache-Control'],/no-store/);
  }}finally{global.fetch=saved;}
});
test('current allowlist role overrides a stale admin JWT',async()=>{
  const out=res();const u=await S.requireUser(await request(),out,['admin'],{fetcher:list()});assert.equal(u,null);assert.equal(out.code,403);
});
test('removed, pending and explicitly blocked accounts cannot use APIs',async()=>{
  for(const fetcher of [list([]),list([{id:'123',role:'pending'}]),list([{id:'123',role:'admin'}],[{id:'123'}])]){
    const out=res();assert.equal(await S.requireUser(await request(),out,undefined,{fetcher}),null);assert.equal(out.code,403);
  }
});
test('access store outage denies access without bootstrap administrator',async()=>{
  const out=res();await S.requireUser(await request(),out,undefined,{fetcher:async()=>{throw Error('offline');}});assert.equal(out.code,503);
  assert.equal(S.currentRole('123',{users:[],blocked:[]}),'pending');
});
test('wrong JWT audience and forged token are rejected',async()=>{
  for(const cookie of ['sewang_session=forged','sewang_session='+await token('admin',{audience:'another-app'})]){
    const out=res();await S.requireUser({method:'GET',headers:{cookie}},out,undefined,{fetcher:list()});assert.equal(out.code,401);
  }
});
test('mutations require POST JSON and the exact trusted Origin',()=>{
  const good={method:'POST',headers:{origin:S.APP_ORIGIN,'content-type':'application/json'}};
  assert.equal(S.mutationAllowed(good,res()),true);
  for(const req of [{...good,method:'GET'},{...good,headers:{}},{...good,headers:{...good.headers,origin:'https://attacker.invalid'}},{...good,headers:{...good.headers,'content-type':'text/plain'}}])assert.equal(S.mutationAllowed(req,res()),false);
});
test('OAuth state requires matching random nonce; malformed cookies are safe',()=>{
  const a=S.oauthState(),b=S.oauthState();assert.notEqual(a,b);assert.equal(S.validState(a,a),true);
  for(const x of [undefined,'',b,'abc'])assert.equal(S.validState(a,x),false);
  assert.doesNotThrow(()=>S.cookies('sewang_session=%invalid'));
  assert.match(S.stateCookie(a),/HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
});
test('data access is allowlisted and roles exclude owner from customer records',()=>{
  for(const f of ['../package.json','%2e%2e/package.json','allowlist.json/other','push_subscriptions.json','missing.json'])assert.equal(S.fileRoles(f),null,f);
  assert.deepEqual(S.fileRoles('usage_log.json'),['admin']);
  assert.equal(S.fileRoles('customers_hash.json').includes('owner'),false);
  assert.ok(S.fileRoles('ytd_2026/202609.json'));
});
test('private records cannot be written to public or unverified repositories',async()=>{
  for(const response of [{ok:true,json:async()=>({private:false})},{ok:false},{ok:true,json:async()=>({})}])await assert.rejects(()=>S.assertPrivateRepository(S.REPO,'test',async()=>response));
  await S.assertPrivateRepository(S.REPO,'test',async()=>({ok:true,json:async()=>({private:true})}));
});
test('push endpoints reject arbitrary hosts, localhost and embedded credentials',()=>{
  for(const u of ['http://127.0.0.1/a','https://example.com/a','https://fcm.googleapis.com.evil.invalid/a','https://user@fcm.googleapis.com/a'])assert.equal(S.validPushEndpoint(u),false);
  assert.equal(S.validPushEndpoint('https://fcm.googleapis.com/fcm/send/test'),true);
});
test('actual auth handler rejects anonymous data and OAuth callbacks before upstream fetch',async()=>{
  const handler=(await import('../api/auth/kakao.js')).default;const saved=global.fetch;
  global.fetch=()=>{throw Error('unexpected network');};
  try {for(const [query,expected] of [[{action:'data',file:'customers_hash.json'},401],[{code:'test'},403]]){
    const out=res();await handler({method:'GET',headers:{},query},out);assert.equal(out.code,expected);
  }}finally{global.fetch=saved;}
});
test('actual auth handler enforces admin and owner data boundaries',async()=>{
  const handler=(await import('../api/auth/kakao.js')).default;const saved=global.fetch;
  try {
    global.fetch=list();let out=res();await handler(await request({query:{action:'list_users'}}),out);assert.equal(out.code,403);
    global.fetch=list([{id:'123',role:'owner'}]);out=res();await handler(await request({query:{action:'data',file:'customers_hash.json'}}),out);assert.equal(out.code,403);
    global.fetch=list([{id:'123',role:'admin'}]);out=res();await handler(await request({query:{action:'approve'}}),out);assert.equal(out.code,405);
  }finally{global.fetch=saved;}
});
test('static build only publishes the explicit browser asset allowlist',()=>{
  const {build,files}=require('../scripts/build-static.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'sewang-static-test-'));
  try{
    for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'fixture');}
    fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data','allowlist.json'),'private fixture');
    build(root);assert.equal(fs.existsSync(path.join(root,'dist','data')),false);assert.equal(fs.existsSync(path.join(root,'dist','api')),false);
    assert.deepEqual(fs.readdirSync(path.join(root,'dist')).sort(),['assets','icon.svg','index.html','manifest.json','sw.js']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('large authenticated JSON snapshots preserve Korean data with bounded gzip responses',async()=>{
  const {snapshotResponse}=await import('../lib/snapshots.mjs');const {gunzipSync}=require('node:zlib');
  const raw=JSON.stringify({fixture:'서울 매장 '.repeat(500000)}),out=snapshotResponse(raw,'gzip, deflate, br');
  assert.equal(out.encoding,'gzip');assert.equal(gunzipSync(out.body).toString(),raw);assert.ok(out.body.length<3300000);
  assert.equal(snapshotResponse(raw,'gzip;q=0').status,406);
});
