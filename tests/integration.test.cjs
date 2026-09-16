const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,requestInterceptor,VirtualConsole}=require('jsdom');
const I=require('../assets/intelligence-core.js');
const resources={interceptors:[requestInterceptor(req=>{const u=new URL(req.url);return new Response(u.pathname.startsWith('/assets/')?fs.readFileSync(path.join(process.cwd(),u.pathname)):'',{headers:{'Content-Type':u.pathname.endsWith('.css')?'text/css':'text/javascript'}});})]};
async function boot(role='staff',options={}){
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
 Object.assign(fixtures,options.fixtures||{});
 const requests=[],errors=[];const console=new VirtualConsole();console.on('jsdomError',e=>{if(!/Not implemented/.test(e.message))errors.push(e.message);});
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.invalid/',runScripts:'dangerously',resources,virtualConsole:console,pretendToBeVisual:true,beforeParse(w){
  w.Chart=class {destroy(){} resize(){}};
  for(const [key,value] of Object.entries(options.storage||{}))w.localStorage.setItem(key,JSON.stringify(value));
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  w.fetch=async url=>{const u=new URL(url,'https://fixture.invalid');requests.push(u.pathname+u.search);if(options.failData&&u.pathname.startsWith('/data/'))return {ok:false,status:503};const data=u.pathname==='/api/auth/kakao'&&u.searchParams.get('action')==='me'?(role==='anonymous'?{authenticated:false}:{authenticated:true,user:{id:'fixture',role,nickname:'테스트'}}):fixtures[u.pathname]||{items:[],stores:[],brands:[],total:0};return {ok:true,status:200,json:async()=>data,headers:{get:()=>null}};};
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
test('existing device records are recovered through the visible button with current edits and customer badges preserved',async()=>{
 const original={tracked:[{id:'old-track',name:'기존 추적',note:'보존할 메모',addr:'서울'}]};
 const {dom,errors}=await boot('staff',{storage:{'sewang-v12':original,sewang_customer_stores:{stores:[{n:'이전 거래처',r:'서울'}]},sewang_customers:{brands:['이전 브랜드']},sewang_visits:{visits:[{ts:Date.now()-86400000,tabs:['영업관리']}],total_count:10,first_visit:Date.now()-86400000*10}}});
 const w=dom.window;
 try{
  assert.equal(w.ST.tracked.length,0);assert.equal(w.isCustomerStore('이전 거래처','서울'),false);
  const button=w.document.getElementById('restore-device-records');assert.ok(button);button.click();
  assert.equal(w.ST.tracked[0].note,'보존할 메모');assert.equal(w.loadCustomers()[0],'이전 브랜드');
  assert.equal(w.isCustomerStore('이전 거래처','서울'),true);
  assert.equal(w.localStorage.getItem('sewang-v12'),JSON.stringify(original));
  assert.match(w.document.getElementById('app-data-notices').textContent,/복구했습니다/);
  assert.doesNotMatch(w.document.getElementById('vh-badge').textContent,/첫 방문/);
  assert.equal(w.document.getElementById('restore-device-records'),null);assert.deepEqual(errors,[]);
 }finally{w.close();}
});
test('server data failure is visible and does not masquerade as zero stores',async()=>{
 const {dom}=await boot('staff',{failData:true});const w=dom.window;
 try{
  assert.match(w.document.getElementById('app-data-notices').textContent,/불러오지 못했습니다/);
  assert.match(w.document.getElementById('si-content').textContent,/0건이라는 뜻은 아닙니다/);
  assert.equal(w.document.querySelector('#si-content .si-kpis'),null);
 }finally{w.close();}
});
test('year-to-date brands and branch details render even when the recent snapshot is empty',async()=>{
 const {dom}=await boot('staff',{fixtures:{'/data/trend30_all.json':{at:new Date().toISOString(),stores:[],byDay:{},failures:[]}}});
 const w=dom.window;
 try{
  w.switchPage('fr');w.renderFr();assert.equal(w.BRANDS.length,0);
  assert.match(w.document.getElementById('fr-ytd-summary').textContent,/개점 3/);
  assert.match(w.document.getElementById('tbl-brand').textContent,/테스트 주막/);
  w.document.querySelector('#tbl-brand tr[onclick]').click();
  assert.match(w.document.getElementById('fr-detail').textContent,/테스트 주막/);
 }finally{w.close();}
});
test('failed collection snapshot cannot replace existing permits or hide YTD brands',async()=>{
 const cached={id:'existing-permit',name:'기존 주막',addr:'서울특별시 강남구 테헤란로 12',permitDate:'20260910',type:'ilban',upte:'기타'};
 const {dom}=await boot('staff',{storage:{'sewang-account-v18:fixture:sewang-v12':{tracked:[],permits:[cached]}},fixtures:{'/data/trend30_all.json':{at:new Date().toISOString(),stores:[],byDay:{},failures:['seoul','busan']}}});
 const w=dom.window;
 try{
  assert.equal(w.ST.permits[0]?.id,'existing-permit');
  assert.equal(w.APP_DATA_STATE['trend30_all.json'],'error');
  w.switchPage('fr');w.renderFr();assert.match(w.document.getElementById('tbl-brand').textContent,/테스트 주막/);
 }finally{w.close();}
});
test('real YTD snapshot renders brand rankings, category filtering and branch details with no recent records',async()=>{
 const {dom}=await boot('staff',{fixtures:{'/data/trend30_all.json':{at:new Date().toISOString(),stores:[],byDay:{},failures:[]},'/data/ytd_2026_summary.json':JSON.parse(fs.readFileSync('data/ytd_2026_summary.json'))}});
 const w=dom.window;
 try{
  w.switchPage('fr');w.renderFr();assert.ok(w.document.querySelectorAll('#tbl-brand tr[onclick]').length>0);
  w.document.querySelector('#chip-fr-kind [data-v="sool"]').click();
  const row=w.document.querySelector('#tbl-brand tr[onclick]');assert.ok(row);row.click();
  assert.ok(w.document.getElementById('fr-detail').textContent.length>100);
  assert.doesNotMatch(w.document.getElementById('tbl-brand').textContent,/신규업장 탭에서 조회/);
 }finally{w.close();}
});
