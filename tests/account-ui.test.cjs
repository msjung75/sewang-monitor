const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const html=fs.readFileSync('account.html','utf8'),script=fs.readFileSync('assets/account.js','utf8');
const settle=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};
function ui(mode='',account={ok:true,ready:true,configured:false,recentKakao:true,devices:[]}){
 const calls=[];
 const dom=new JSDOM(html,{url:'https://sewang-monitor.vercel.app/account.html'+mode,runScripts:'outside-only'});
 const w=dom.window;
 w.fetch=async(url,options={})=>{
  const action=new URL(url,w.location).searchParams.get('action');let body;try{body=JSON.parse(options.body || '{}');}catch{}
  calls.push({action,body});
  if(action==='account')return {ok:true,json:async()=>account};
  if(action==='setup'||action==='login'||action==='change')return {ok:true,json:async()=>({ok:true,verification_required:true,email:'f***@example.test',mode:action==='setup'?'setup':'login'})};
  if(action==='challenge')return {ok:true,json:async()=>({email:'f***@example.test',mode:'login'})};
  if(action==='verify')return {ok:false,json:async()=>({error:'device_limit',devices:[{id:'a'.repeat(64),name:'업무용 휴대폰',lastLogin:1},{id:'b'.repeat(64),name:'<img src=x onerror=alert(1)>',lastLogin:2}]})};
  throw Error('unexpected fixture action');
 };
 w.confirm=()=>false;w.eval(script);
 return {dom,w,calls,close:()=>w.close()};
}
test('account enrollment checks confirmation, sends credentials only via POST and clears password fields before OTP view',async()=>{
 const d=ui();try{await settle();const f=d.w.document.querySelector('form');for(const [name,value] of Object.entries({username:'fixture.user',email:'fixture@example.test','new-password':'fixture unique password 2026','password-again':'different fixture password',deviceName:'첫 번째 휴대폰'}))f.elements[name].value=value;
 f.dispatchEvent(new d.w.Event('submit',{cancelable:true}));await settle();assert.equal(d.calls.filter(x=>x.action==='setup').length,0);assert.match(d.w.document.getElementById('notice').textContent,/비밀번호가 다릅니다/);
 f.elements['password-again'].value=f.elements['new-password'].value;f.dispatchEvent(new d.w.Event('submit',{cancelable:true}));await settle();assert.equal(d.calls.filter(x=>x.action==='setup').length,1);assert.equal(f.elements['new-password'].value,'');assert.equal(f.elements['password-again'].value,'');assert.match(d.w.document.getElementById('heading').textContent,/이메일 인증/);assert.ok(!d.w.location.href.includes('password'));assert.equal(d.w.localStorage.length,0);
 }finally{d.close();}
});
test('third-device verification offers explicit replacement, treats device labels as text and sends nothing when cancelled',async()=>{
 const d=ui('?mode=verify');try{await settle();const form=d.w.document.querySelector('form');form.elements.code.value='123456';form.dispatchEvent(new d.w.Event('submit',{cancelable:true}));await settle();assert.match(d.w.document.getElementById('heading').textContent,/두 대/);assert.equal(d.w.document.querySelectorAll('img').length,0);assert.match(d.w.document.getElementById('content').textContent,/<img/);d.w.document.querySelector('button').click();await settle();assert.equal(d.calls.filter(x=>x.action==='replace').length,0);
 }finally{d.close();}
});
test('anonymous login and account setup screens explain how to connect an existing approved identity',async()=>{
 const d=ui('?mode=login');try{await settle();assert.equal(d.w.document.querySelector('[name=password]').autocomplete,'current-password');assert.ok(d.w.document.querySelector('a[href="/api/auth/kakao?action=login"]'));assert.match(d.w.document.body.textContent,/기존 카카오 계정/);}finally{d.close();}
 const stale=ui('',{ready:true,configured:false,recentKakao:false,devices:[]});try{await settle();assert.equal(stale.w.document.querySelectorAll('input[type=password]').length,0);assert.match(stale.w.document.body.textContent,/카카오로 다시 로그인/);}finally{stale.close();}
});
