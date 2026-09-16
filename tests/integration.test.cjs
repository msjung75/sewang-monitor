const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,requestInterceptor,VirtualConsole}=require('jsdom');
const I=require('../assets/intelligence-core.js');
const resources={interceptors:[requestInterceptor(req=>{const u=new URL(req.url);return new Response(u.pathname.startsWith('/assets/')?fs.readFileSync(path.join(process.cwd(),u.pathname)):'',{headers:{'Content-Type':u.pathname.endsWith('.css')?'text/css':'text/javascript'}});})]};
async function boot(role='staff'){
 const date=new Date().toISOString(),ymd=date.slice(0,10).replace(/-/g,'');
 const store={id:'test-only',name:'테스트 주막',addr:'서울특별시 강남구 테헤란로 12',type:'ilban',typeLabel:'일반음식점',upte:'기타',permitDate:ymd,tel:'',closedDate:'',status:'영업'};
 const current=ymd.slice(0,6),months=['202607','202608',current];const monthly={};months.forEach((m,i)=>monthly[m]={open:1,closed:0,stores:[{...store,id:'b-'+i,permitDate:m+'01'}]});
 const fixtures={
  '/data/trend30_all.json':{at:date,stores:[store],byDay:{[ymd]:1},failures:0},
  '/data/naver_nstat_cache.json':{'test-only':I.match(store,[])},
  '/data/ytd_2026_summary.json':{at:date,year:2026,months_loaded:months,by_brand:{'테스트 주막':{total_open:3,total_closed:0,monthly}},by_month:Object.fromEntries(months.map(m=>[m,{open:1,closed:0}])),by_sido:{},by_upte:{}},
  '/data/franchise_master.json':{brands:[],total:0},
  '/data/brand_overrides.json':{aliases:[],excluded:[],categories:{},store_excluded:[]}
 };
 const requests=[],errors=[];const console=new VirtualConsole();console.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message);});
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.invalid/',runScripts:'dangerously',resources,virtualConsole:console,pretendToBeVisual:true,beforeParse(w){
  w.Chart=class {destroy(){} resize(){}};
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.fetch=async url=>{const u=new URL(url,'https://fixture.invalid');requests.push(u.pathname+u.search);const data=u.pathname==='/api/auth/kakao'&&u.searchParams.get('action')==='me'?(role==='anonymous'?{authenticated:false}:{authenticated:true,user:{id:'fixture',role,nickname:'테스트'}}):fixtures[u.pathname]||{items:[],stores:[],brands:[],total:0};return {ok:true,status:200,json:async()=>data,headers:{get:()=>null}};};
 }});
 await new Promise(resolve=>dom.window.addEventListener('load',()=>setTimeout(resolve,100),{once:true}));
 return {dom,requests,errors};
}
test('complete app bootstrap loads the new workspace after allowed authentication',async()=>{const {dom,errors}=await boot();try{assert.equal(dom.window.document.documentElement.classList.contains('auth-pending'),false);assert.ok(dom.window.document.getElementById('si-workspace'));assert.match(dom.window.document.getElementById('si-leads').textContent,/테스트 주막/);assert.deepEqual(errors,[]);}finally{dom.window.close();}});
test('anonymous bootstrap displays login, not the sales workspace',async()=>{const {dom,requests}=await boot('anonymous');try{assert.equal(dom.window.document.getElementById('si-workspace'),null);assert.match(dom.window.document.body.textContent,/카카오로 로그인/);assert.equal(requests.some(x=>x.startsWith('/api/local')),false);}finally{dom.window.close();}});
test('pending account cannot mount staff workspace',async()=>{const {dom}=await boot('pending');try{assert.equal(dom.window.document.getElementById('si-workspace'),null);assert.match(dom.window.document.body.textContent,/승인/);}finally{dom.window.close();}});
test('account switches do not load another account or legacy unowned browser records',async()=>{
 const {dom}=await boot();const w=dom.window;
 try{
  w.localStorage.setItem('sewang-v12',JSON.stringify({tracked:[{id:'legacy'}]}));
  w.ST.tracked=[{id:'account-a',memo:'private fixture'}];w.save();
  w.ME={id:'account-b',role:'staff'};w.loadAccountState();assert.equal(w.ST.tracked.length,0);
  w.ME={id:'fixture',role:'staff'};w.loadAccountState();assert.equal(w.ST.tracked[0].id,'account-a');
  w.ME=null;w.loadAccountState();assert.equal(w.ST.tracked.length,0);assert.equal(w.appStorageGetItem('sewang-v12'),null);
 }finally{w.close();}
});
test('untrusted names stay strings in legacy inline event arguments',async()=>{
 const {dom}=await boot();const w=dom.window;
 try {
  const payload="x';window.__injected=1;//\"<&";
  const box=w.document.createElement('div');box.innerHTML='<button onclick="window.__value=\''+w.jsEsc(payload)+'\'">test</button>';
  w.document.body.append(box);box.firstChild.click();
  assert.equal(w.__injected,undefined);assert.equal(w.__value,payload);
 }finally{w.close();}
});
