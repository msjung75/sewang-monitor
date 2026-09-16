/* DOM behavior tests, not browser screenshots or real-account integration tests. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
function setup(){
 const dom=new JSDOM('<!doctype html><html><body><div class="main"><div class="page on" id="pg-home"><div class="card">Legacy chart</div></div></div><nav class="bnav"></nav></body></html>',{url:'https://fixture.invalid',runScripts:'outside-only'});
 const w=dom.window;
 w.eval(fs.readFileSync('assets/intelligence-core.js','utf8'));
 const d=new Date().toISOString().slice(0,10).replace(/-/g,'');
 w.ME={id:'test-user',role:'staff'};
 w.APP_DATA_STATE={'trend30_all.json':'ready','ytd_2026_summary.json':'ready'};
 w.ST={permits:[{id:'test-store',name:'테스트 주막',addr:'서울특별시 강남구 테헤란로 12',permitDate:d,type:'ilban',typeLabel:'일반음식점',upte:'기타'}],naver:{},tracked:[],lastFetch:new Date().toISOString()};
 w.fmtYmd=x=>x||'-';w.save=()=>{};w.renderCharts=()=>{};w.loadCustomers=()=>[];w.saveCustomers=()=>{};w.isCustomerBrand=()=>false;w.isFranchiseRegistered=()=>false;w.switchPage=pg=>{w.lastPage=pg;};w.selectBrand=()=>{};
 w.analyzeStore=async s=>{w.ST.naver[s.id]=w.SewangIntelligence.match(s,[]);};
 w.eval(fs.readFileSync('assets/intelligence-ui.js','utf8'));w.mountIntelligence();
 return dom;
}
test('four purpose tabs and sales evidence render',()=>{const dom=setup(),d=dom.window.document;assert.equal(d.querySelectorAll('[role=tab]').length,4);assert.match(d.getElementById('si-detail').textContent,/규칙 점수|정확도 %가 아닙니다/);assert.match(d.getElementById('si-leads').textContent,/테스트 주막/);dom.window.close();});
test('search filters sales rows and handles empty results',()=>{const dom=setup(),w=dom.window,input=w.document.getElementById('si-search');input.value='없는매장';input.dispatchEvent(new w.Event('input',{bubbles:true}));assert.match(w.document.getElementById('si-leads').textContent,/매장이 없습니다/);dom.window.close();});
test('same-store confirmation requires evidence',()=>{const dom=setup(),w=dom.window,f=w.document.getElementById('si-review');f.elements.match.value='confirmed';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.match(w.document.getElementById('si-feedback').textContent,/근거/);assert.equal(w.ST.tracked.length,0);dom.window.close();});
test('saving review creates a tracked opportunity and preserves fields',()=>{const dom=setup(),w=dom.window,f=w.document.getElementById('si-review');f.elements.match.value='confirmed';f.elements.evidence.value='테스트 현장 확인';f.elements.owner.value='테스트 담당';f.elements.status.value='visit';f.elements.opening.value='preparing';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.equal(w.ST.tracked.length,1);assert.equal(w.ST.tracked[0].status,'visit');assert.equal(w.ST.tracked[0].owner,'테스트 담당');assert.match(w.document.getElementById('si-feedback').textContent,/저장했습니다/);assert.equal(JSON.parse(w.localStorage.getItem('sewang-evidence-v18-test-user'))['test-store'].opening,'preparing');dom.window.close();});
test('viewport resize does not recreate the form or lose selection/draft',()=>{const dom=setup(),w=dom.window,f=w.document.getElementById('si-review');f.elements.note.value='작성 중';const id=w.document.querySelector('[data-lead][aria-pressed=true]').dataset.lead;for(const width of [390,768,1024,1440]){Object.defineProperty(w,'innerWidth',{value:width,configurable:true});w.dispatchEvent(new w.Event('resize'));assert.equal(w.document.getElementById('si-review'),f);assert.equal(f.elements.note.value,'작성 중');assert.equal(w.document.querySelector('[data-lead][aria-pressed=true]').dataset.lead,id);}dom.window.close();});
test('trends require completed monthly periods',()=>{const dom=setup(),w=dom.window;w.document.querySelector('[data-view=trends]').click();assert.match(w.document.getElementById('si-content').textContent,/완료된 월 자료/);dom.window.close();});
test('brand acquisition defaults to nationwide',()=>{const dom=setup(),w=dom.window;w.document.querySelector('[data-view=acquire]').click();assert.equal(w.document.getElementById('si-brand-scope').value,'all');dom.window.close();});
test('owner audience does not receive staff sales workspace',()=>{const dom=setup(),w=dom.window;w.document.getElementById('si-workspace').remove();w.ME.role='owner';w.mountIntelligence();assert.equal(w.document.getElementById('si-workspace'),null);dom.window.close();});
test('responsive CSS has compact, unfolded and desktop layouts',()=>{const css=fs.readFileSync('assets/intelligence.css','utf8');assert.match(css,/max-width:719px/);assert.match(css,/min-width:720px/);assert.match(css,/min-width:1450px/);assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);});
