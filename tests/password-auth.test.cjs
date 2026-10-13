const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const serverPath=process.env.TEST_REDIS_SERVER,cliPath=process.env.TEST_REDIS_CLI;
const integration=!!serverPath&&!!cliPath;
let port;
let server,dir,S,P,C,handler,kakao,SignJWT,originalFetch,mails,mailFail,blocked;
const password='fixture unique password 2026';
const redis=(...args)=>JSON.parse(execFileSync(cliPath,['-p',String(port),'--json',...args.map(String)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));
function res(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},getHeader(k){return this.headers[k];},status(code){this.code=code;return this;},json(v){this.body=v;return this;},send(v){this.body=v;return this;},end(v){this.body=v;return this;},redirect(code,url){this.code=code;this.url=url;}};}
class Browser {
 constructor(){this.jar={};}
 cookie(){return Object.entries(this.jar).map(([k,v])=>k+'='+v).join('; ');}
 accept(out){for(const value of [].concat(out.headers['Set-Cookie']||[])){const [kv]=value.split(';');const i=kv.indexOf('=');if(value.includes('Max-Age=0'))delete this.jar[kv.slice(0,i)];else this.jar[kv.slice(0,i)]=kv.slice(i+1);}}
 async request(action,body,headers={}){const out=res();await handler({method:body?'POST':'GET',query:{action},body,headers:{cookie:this.cookie(),origin:S.APP_ORIGIN,'content-type':'application/json','user-agent':'Android fixture',...headers},socket:{remoteAddress:'127.0.0.1'}},out);this.accept(out);return out;}
}
async function seed(browser,id='123',age=0){browser.jar.sewang_session=await new SignJWT({id,n:'가상 사용자',r:'staff',auth_method:'kakao'}).setProtectedHeader({alg:'HS256'}).setIssuer(S.APP_ORIGIN).setAudience(S.SESSION_OPTIONS.audience).setIssuedAt(P.nowSeconds()-age).setExpirationTime('24h').sign(S.sessionKey());return browser;}
const code=()=>mails.at(-1).text.match(/\b\d{6}\b/)[0];
async function enroll(){const a=await seed(new Browser());const r=await a.request('setup',{username:'fixture.user',email:'fixture@example.test',password,deviceName:'첫 번째 휴대폰'});assert.equal(r.code,200,JSON.stringify(r.body));const v=await a.request('verify',{code:code()});assert.equal(v.code,200,JSON.stringify(v.body));return a;}
async function second(){const b=new Browser();const r=await b.request('login',{username:'fixture.user',password,deviceName:'두 번째 휴대폰'});assert.equal(r.body.verification_required,true);assert.ok(!b.jar.sewang_session);const v=await b.request('verify',{code:code()});assert.equal(v.code,200,JSON.stringify(v.body));return b;}
before(async()=>{
 process.env.JWT_SECRET='fixture-secret-'.repeat(4);process.env.GITHUB_TOKEN='fixture';process.env.KAKAO_REST_KEY='fixture';process.env.ADMIN_KAKAO_ID='';
 S=await import('../lib/security.mjs');P=await import('../lib/password-auth.mjs');C=await import('../lib/credential-store.mjs');({SignJWT}=await import('jose'));handler=(await import('../api/password.js')).default;kakao=(await import('../api/auth/kakao.js')).default;
 if(!integration)return;
 const socket=require('node:net').createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));port=socket.address().port;await new Promise(r=>socket.close(r));
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'sewang-auth-redis-'));server=spawn(serverPath,['--port',String(port),'--bind','127.0.0.1','--protected-mode','yes','--save','','--appendonly','no','--dir',dir],{stdio:'ignore'});
 for(let i=0;i<50;i++){try{if(redis('PING')==='PONG')break;}catch{}await new Promise(r=>setTimeout(r,40));}
 assert.equal(redis('PING'),'PONG');
 process.env.KV_REST_API_URL='https://fixture.upstash.test';process.env.KV_REST_API_TOKEN='fixture';process.env.RESEND_API_KEY='fixture';
 originalFetch=global.fetch;
 global.fetch=async(url,options={})=>{
  if(url==='https://fixture.upstash.test'){const result=redis(...JSON.parse(options.body));return {ok:true,json:async()=>({result})};}
  if(String(url).startsWith('https://api.github.com/'))return {ok:true,json:async()=>({content:Buffer.from(JSON.stringify({users:[{id:'123',role:'staff',nickname:'가상 사용자'},{id:'456',role:'staff'}],blocked:blocked?[{id:'123'}]:[]})).toString('base64')})};
  if(url==='https://api.resend.com/emails'){if(mailFail)return {ok:false};mails.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:'fixture'})};}
  if(url==='https://kauth.kakao.com/oauth/token')return {ok:true,json:async()=>({access_token:'fixture'})};
  if(url==='https://kapi.kakao.com/v2/user/me')return {ok:true,json:async()=>({id:123,properties:{nickname:'가상 사용자'}})};
  throw Error('unexpected external request');
 };
});
beforeEach(()=>{if(integration){redis('FLUSHDB');mails=[];mailFail=false;blocked=false;}});
after(async()=>{if(integration){global.fetch=originalFetch;delete process.env.KV_REST_API_URL;delete process.env.KV_REST_API_TOKEN;try{redis('SHUTDOWN','NOSAVE');}catch{}server.kill();await new Promise(r=>setTimeout(r,50));fs.rmSync(dir,{recursive:true,force:true});}});

test('password hashes use unique salts and reject wrong passwords and malformed hashes',async()=>{
 const a=await P.hashPassword(password),b=await P.hashPassword(password);assert.notEqual(a,b);assert.ok(!a.includes(password));assert.equal(await P.checkPassword(password,a),true);assert.equal(await P.checkPassword('wrong password',a),false);await assert.rejects(P.checkPassword(password,'plain text'));
 for(const bad of ['short','123456789012345','a'.repeat(15)])assert.throws(()=>P.passwordPolicy(bad));
 assert.throws(()=>P.username('abc'));assert.throws(()=>P.email('bad'));assert.equal(P.username('Test.User'),'test.user');
});
test('two enrolled devices work; a third must explicitly replace one and cannot reuse the proof',{skip:!integration},async()=>{
 const a=await enroll(),b=await second(),c=new Browser();const firstToken=a.jar.sewang_session;
 let r=await c.request('login',{username:'fixture.user',password,deviceName:'세 번째 휴대폰'});assert.equal(r.body.verification_required,true);
 const proof=code();r=await c.request('verify',{code:proof});assert.equal(r.code,409);assert.equal(r.body.error,'device_limit');assert.equal(r.body.devices.length,2);assert.ok(!c.jar.sewang_session);
 const old=(await a.request('account')).body.devices.find(d=>d.current);
 r=await c.request('replace',{replaceDeviceId:old.id});assert.equal(r.code,200);
 assert.equal(await S.readSession({headers:{cookie:'sewang_session='+firstToken}}),null);
 assert.equal((await b.request('account')).code,200);assert.equal((await c.request('account')).body.devices.length,2);
 assert.equal((await c.request('verify',{code:proof})).body.error,'verification_expired');
 const record=await C.readCredential('123');assert.equal(record.id,'123');assert.ok(!record.passwordHash.includes(password));
});
test('trusted password login skips email; remote revocation and logout immediately invalidate session',{skip:!integration},async()=>{
 const a=await enroll(),b=await second(),old=b.jar.sewang_session;const n=mails.length;
 assert.equal((await b.request('login',{username:'fixture.user',password})).body.ok,true);assert.equal(mails.length,n);
 assert.equal(await S.readSession({headers:{cookie:'sewang_session='+old}}),null);
 const device=(await a.request('account')).body.devices.find(d=>!d.current);
 assert.equal((await a.request('revoke',{deviceId:device.id})).code,200);assert.equal((await b.request('account')).code,401);
 const out=res();await kakao({method:'POST',query:{action:'logout'},headers:{cookie:a.cookie(),origin:S.APP_ORIGIN,'content-type':'application/json'},body:{}},out);assert.equal(out.code,200);a.accept(out);assert.ok(!a.jar.sewang_session);assert.equal(Object.keys(await C.readDevices('123')).length,0);
});
test('wrong code, another browser, expiry and changed credentials cannot complete an email proof',{skip:!integration},async()=>{
 const a=await enroll(),b=new Browser();await b.request('login',{username:'fixture.user',password});const proof=code();
 const other=new Browser();other.jar={...b.jar,sewang_device:P.randomToken()};assert.equal((await other.request('verify',{code:proof})).body.error,'verification_expired');
 const wrong=proof==='000000'?'111111':'000000';for(let i=0;i<5;i++)assert.equal((await b.request('verify',{code:wrong})).body.error,'invalid_code');
 assert.equal((await b.request('verify',{code:proof})).body.error,'verification_expired');
 await b.request('login',{username:'fixture.user',password});const challenge=b.jar.sewang_challenge;redis('DEL',C.challengeKey(challenge));assert.equal((await b.request('verify',{code:code()})).body.error,'verification_expired');
});
test('enrollment requires recent approved Kakao authentication and never accepts cross-origin mutations',{skip:!integration},async()=>{
 const anon=new Browser();assert.equal((await anon.request('setup',{username:'fixture.user',email:'fixture@example.test',password})).code,401);
 const old=await seed(new Browser(),'123',601);assert.equal((await old.request('setup',{username:'fixture.user',email:'fixture@example.test',password})).body.error,'reauthentication_required');
 const a=await seed(new Browser());assert.equal((await a.request('setup',{username:'fixture.user',email:'fixture@example.test',password},{origin:'https://attacker.test'})).code,403);assert.equal(mails.length,0);
 blocked=true;assert.equal((await a.request('setup',{username:'fixture.user',email:'fixture@example.test',password})).code,403);
});
test('password guessing is bounded, mail failures issue no usable challenge, and username ownership is unique',{skip:!integration},async()=>{
 const a=await enroll(),b=new Browser();for(let i=0;i<8;i++)assert.equal((await b.request('login',{username:'fixture.user',password:'wrong password'})).code,401);assert.equal((await b.request('login',{username:'fixture.user',password})).code,429);
 const different=await seed(new Browser(),'456');assert.equal((await different.request('setup',{username:'fixture.user',email:'other@example.test',password})).body.error,'username_unavailable');
 mailFail=true;assert.equal((await different.request('setup',{username:'another.user',email:'other@example.test',password})).body.error,'email_delivery_failed');assert.ok(!different.jar.sewang_challenge);assert.equal(await C.readCredential('456'),null);
});
test('Kakao login also requires email on new devices and respects two-device enrollment',{skip:!integration},async()=>{
 const a=await enroll(),b=await second(),c=new Browser();const nonce=S.oauthState();c.jar[S.stateCookieName(nonce)]=nonce;
 const out=res();await kakao({method:'GET',query:{code:'fixture',state:nonce},headers:{cookie:c.cookie()}},out);c.accept(out);assert.equal(out.url,'/account.html?mode=verify');assert.ok(!c.jar.sewang_session);
 const r=await c.request('verify',{code:code()});assert.equal(r.body.error,'device_limit');
 const nonce2=S.oauthState();a.jar[S.stateCookieName(nonce2)]=nonce2;const ok=res();await kakao({method:'GET',query:{code:'fixture',state:nonce2},headers:{cookie:a.cookie()}},ok);a.accept(ok);assert.equal(ok.url,'/?login=ok');assert.equal((await S.readSession({headers:{cookie:a.cookie()}})).auth_method,'kakao');
});
test('fresh Kakao plus verified email password reset revokes other devices and all old credential proofs',{skip:!integration},async()=>{
 const a=await enroll(),b=await second();const nonce=S.oauthState();a.jar[S.stateCookieName(nonce)]=nonce;const out=res();await kakao({method:'GET',query:{code:'fixture',state:nonce},headers:{cookie:a.cookie()}},out);a.accept(out);
 const newer='fixture replacement password 2026';let r=await a.request('change',{password:newer});assert.equal(r.code,200);r=await a.request('verify',{code:code()});assert.equal(r.code,200);assert.equal((await b.request('account')).code,401);assert.equal((await a.request('account')).body.devices.length,1);assert.equal((await a.request('login',{username:'fixture.user',password})).code,401);assert.equal((await a.request('login',{username:'fixture.user',password:newer})).code,200);
});
test('concurrent new devices cannot overbook the second slot',{skip:!integration},async()=>{
 const a=await enroll(),b=new Browser(),c=new Browser();await b.request('login',{username:'fixture.user',password,deviceName:'B'});const bCode=code();await c.request('login',{username:'fixture.user',password,deviceName:'C'});const cCode=code();
 const results=await Promise.all([b.request('verify',{code:bCode}),c.request('verify',{code:cCode})]);assert.deepEqual(results.map(r=>r.code).sort(),[200,409]);assert.equal((await a.request('account')).body.devices.length,2);
});
test('malformed or unavailable private storage and credential version changes deny access',{skip:!integration},async()=>{
 const a=await enroll(),saved=global.fetch;
 try{global.fetch=async(url,options)=>url==='https://fixture.upstash.test'?{ok:true,json:async()=>({wrong:'shape'})}:saved(url,options);assert.equal((await a.request('account')).code,503);}finally{global.fetch=saved;}
 const account=await C.readCredential('123');account.version=P.randomToken();redis('SET',C.credentialKey('123'),JSON.stringify(account));assert.equal((await a.request('account')).code,401);
});
