/* v18: purpose-specific workspace. No sample figures, hidden enrichment or cloud CRM writes. */
(function () {
  'use strict';
  const I=window.SewangIntelligence;
  const views=[['sales','01','신규 매장 영업','지금 확인할 매장'],['trends','02','창업 트렌드','업태·지역 변화'],['acquire','03','신규 브랜드 유치','본사 접촉 후보'],['expand','04','기존 브랜드 영업','추가 지점·거래 확대']];
  const statuses={new:'연락 필요',contacted:'연락 완료',visit:'방문 예정',proposal:'제안·협의',active:'거래 중',pass:'보류'};
  let view='sales',selected='',query='',scope='metro',filter='all',reviewKey='',reviews={},rows=[],brands=[],brandSource=null,brandAliases=null,brandOverrides=null;
  const viewScopes={sales:'metro',trends:'metro',acquire:'all',expand:'all'};
  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $=id=>document.getElementById(id);
  function tag(s,kind){return '<span class="si-tag '+(kind||'')+'">'+esc(s)+'</span>';}
  function num(v){return Number(v||0).toLocaleString('ko-KR');}
  function entry(s){return (ST.naver||{})[s.id];}
  function review(s){return reviews[s.id]||{};}
  function checked(s){return review(s).match==='confirmed';}
  function matchLabel(s){return checked(s)?'사용자 매칭 확인':review(s).match==='rejected'?'다른 매장 · 재검토':I.labels[I.state(entry(s))];}
  function sourceStamp(){return ST.trend30&&ST.trend30.at || ST.lastFetch;}
  function renderTime(value){const d=new Date(value||0);return +d?d.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'})+' KST':'수집일 미확인';}
  function refreshData(){
    const seen=new Set();
    rows=(ST.permits||[]).filter(s=>{if(!s.id||seen.has(s.id)||(window._excludedStoreSet||{})[s.id])return false;seen.add(s.id);return true;});
    if(brandSource!==window.YTD || brandAliases!==window.BRAND_ALIASES || brandOverrides!==window.BRAND_OVERRIDES){
      brandSource=window.YTD;brandAliases=window.BRAND_ALIASES;brandOverrides=window.BRAND_OVERRIDES;brands=[];
      const groups=new Map();
      Object.entries(window.YTD&&YTD.by_brand||{}).forEach(([name,b])=>{
        const canonical=(window.BRAND_ALIASES||{})[I.norm(name)]||name;
        if((window._excludedBrandSet||{})[name]||(window._excludedBrandSet||{})[canonical])return;
        const key=I.norm(canonical);if(!groups.has(key))groups.set(key,{brand:canonical,stores:[]});
        Object.values(b.monthly||{}).forEach(m=>groups.get(key).stores.push(...(m.stores||[]).filter(s=>!(window._excludedStoreSet||{})[s.id])));
      });
      groups.forEach(g=>{g.metrics=I.brandMetrics(g.stores,Date.parse(YTD.at)||Date.now());if(g.metrics.stores.length>=2)brands.push(g);});
      brands.sort((a,b)=>b.metrics.current90-a.metrics.current90);
    }
  }
  function localNote(){return '<p class="si-note">기록은 이 브라우저의 현재 계정에 저장됩니다. 팀 공유·다른 기기 동기화는 아직 연결되지 않았습니다. 영업 기록은 개인 업무 기기에서 관리해 주세요.</p>';}
  function heading(){
    const date=sourceStamp(), stale=!date||Date.now()-new Date(date).getTime()>3*I.DAY;
    return '<div class="si-heading"><div><div class="si-eyebrow">SEWANG · SALES INTELLIGENCE</div><h1>다음 거래처를 먼저 발견하세요.</h1><p>매장 확인에서 브랜드 유치까지, 근거가 보이는 영업.</p></div><div class="si-stamp"><strong>'+ (stale?'데이터 기준일 확인 필요':'최근 수집 기준')+'</strong>'+esc(renderTime(date))+'</div></div>';
  }
  function tabs(){return '<div class="si-tabs" role="tablist" aria-label="영업 목적">'+views.map(v=>'<button type="button" role="tab" id="si-tab-'+v[0]+'" aria-controls="si-content" class="si-tab" data-view="'+v[0]+'" aria-selected="'+(view===v[0])+'"><i>'+v[1]+'</i><b>'+v[2]+'</b><span>'+v[3]+'</span></button>').join('')+'</div>';}
  function metrics(items){return '<div class="si-kpis">'+items.map(x=>'<div class="si-kpi"><strong>'+esc(x[0])+'</strong><span>'+esc(x[1])+'</span></div>').join('')+'</div>';}
  function bindTabs(){
    document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{viewScopes[view]=scope;view=b.dataset.view;scope=viewScopes[view];query='';selected='';filter='all';render();});
    $('si-tabs').onkeydown=e=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;const buttons=[...$('si-tabs').querySelectorAll('[role=tab]')];const current=buttons.indexOf(document.activeElement);if(current<0)return;e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?buttons.length-1:(current+(e.key==='ArrowRight'?1:buttons.length-1))%buttons.length;buttons[n].click();buttons[n].focus();};
  }
  function render(){
    const host=$('si-workspace');if(!host || !window.ME)return;
    refreshData();
    host.innerHTML=heading()+'<div id="si-tabs">'+tabs()+'</div><div id="si-content" role="tabpanel" aria-labelledby="si-tab-'+view+'"></div>';
    bindTabs();
    if(view==='sales')renderSales();else if(view==='trends')renderTrends();else renderBrands();
  }
  function salesList(){return rows.map(s=>({s,info:I.lead(s,entry(s),review(s))})).filter(x=>{
    if(scope==='metro'&&!I.metro(x.s.addr))return false;
    if(query&&!I.norm(x.s.name+' '+x.s.addr).includes(I.norm(query)))return false;
    const tr=ST.tracked.find(t=>t.id===x.s.id), status=review(x.s).status||tr&&tr.status||'new';
    if(filter==='unresolved'&&!I.isUnresolved(entry(x.s)))return false;
    if(filter==='review'&&!['candidate','ambiguous','legacy','error'].includes(I.state(entry(x.s))))return false;
    if(filter==='new'&&status!=='new')return false;
    return x.info.score>0 && x.info.category.points>3;
  }).sort((a,b)=>b.info.score-a.info.score || String(b.s.permitDate).localeCompare(String(a.s.permitDate)));}
  function renderSales(){
    const eligible=salesList(), n=eligible.filter(x=>checked(x.s)||I.state(entry(x.s))==='matched').length;
    $('si-content').innerHTML=metrics([[num(eligible.length),'현재 조건 영업 후보'],[num(n),'매칭 확인·유력'],[num(eligible.filter(x=>I.isUnresolved(entry(x.s))).length),'검색·후보 추가 확인'],[num(eligible.filter(x=>review(x.s).opening==='preparing').length),'현장 입력 · 오픈 준비']])+
      '<div class="si-toolbar"><input id="si-search" type="search" aria-label="매장명·주소 검색" placeholder="매장명 또는 주소 검색" value="'+esc(query)+'"><select id="si-scope" aria-label="영업 권역"><option value="metro">서울·경기·인천</option><option value="all">전국</option></select><select id="si-filter" aria-label="확인 상태"><option value="all">전체 영업 후보</option><option value="new">미접촉 우선</option><option value="unresolved">검색·후보 추가 확인</option><option value="review">오판·오류 검토</option></select></div>'+
      '<p class="si-note">점수는 수도권 25 · 인허가 최근성 최대 25 · 업태 최대 30 · 연락처 10 · 현장 확인 10의 규칙 점수이며 확률이 아닙니다. 검색 안 됨·첫 리뷰는 미오픈/개업일을 확정하지 않습니다.</p>'+
      '<div class="si-split"><section class="si-panel"><div class="si-panel-head"><h2>확인할 영업 후보</h2><small>상위 60곳 · 인허가 기준</small></div><div id="si-leads"></div></section><aside id="si-detail" class="si-panel si-detail" aria-live="polite"></aside></div>';
    $('si-scope').value=scope;$('si-filter').value=filter;
    $('si-search').oninput=e=>{query=e.target.value;renderLeadRows();};
    $('si-scope').onchange=e=>{scope=e.target.value;renderSales();};
    $('si-filter').onchange=e=>{filter=e.target.value;renderSales();};
    renderLeadRows();
  }
  function renderLeadRows(){
    const list=salesList().slice(0,60);
    if(!list.some(x=>String(x.s.id)===selected))selected=list[0]?String(list[0].s.id):'';
    $('si-leads').innerHTML=list.length?list.map(x=>'<button type="button" class="si-row" data-lead="'+esc(x.s.id)+'" aria-pressed="'+(String(x.s.id)===selected)+'"><span class="si-score">'+x.info.score+'<small>우선순위</small></span><span class="si-row-body"><b>'+esc(x.s.name)+'</b><small>'+esc(x.s.addr)+'</small><div class="si-tags">'+tag(x.info.category.label)+tag(matchLabel(x.s),checked(x.s)?'good':'')+tag('인허가 '+fmtYmd(x.s.permitDate))+'</div></span></button>').join(''):'<div class="si-empty">현재 조건의 매장이 없습니다. 권역·검색 조건 또는 수집 상태를 확인하세요.</div>';
    $('si-leads').querySelectorAll('[data-lead]').forEach(b=>b.onclick=()=>{selected=b.dataset.lead;renderLeadRows();if(innerWidth<720)$('si-detail').scrollIntoView({behavior:'smooth',block:'start'});});
    $('si-leads').querySelectorAll('[data-lead]').forEach(b=>{
      const x=list.find(x=>String(x.s.id)===b.dataset.lead),tr=ST.tracked.find(t=>t.id===x.s.id)||{};
      const info=document.createElement('span');info.className='si-wide-info';
      info.textContent='신고 '+(x.s.upte||x.s.typeLabel||'미기재')+' · '+(x.s.tel?'연락처 있음':'연락처 미확인')+' · '+(statuses[review(x.s).status||tr.status||'new']||'연락 필요');
      b.querySelector('.si-row-body').append(info);
    });
    const current=list.find(x=>String(x.s.id)===selected);renderDetail(current&&current.s);
    const kpi=$('si-content').querySelector('.si-kpis');const eligible=salesList();
    if(kpi)kpi.outerHTML=metrics([[num(eligible.length),'현재 조건 영업 후보'],[num(eligible.filter(x=>checked(x.s)||I.state(entry(x.s))==='matched').length),'매칭 확인·유력'],[num(eligible.filter(x=>I.isUnresolved(entry(x.s))).length),'검색·후보 추가 확인'],[num(eligible.filter(x=>review(x.s).opening==='preparing').length),'현장 입력 · 오픈 준비']]);
  }
  function renderDetail(s){
    if(!s){$('si-detail').innerHTML='<div class="si-empty">목록에서 매장을 선택하면 판단 근거와 영업 기록이 표시됩니다.</div>';return;}
    const r=review(s),e=entry(s)||{},info=I.lead(s,e,r),tr=ST.tracked.find(t=>t.id===s.id)||{};
    const search=encodeURIComponent(s.name+' '+s.addr), candidates=e.version===I.VERSION?e.candidates||[]:[];
    const categoryOptions=['','한식주점','포차·주점','이자카야','호프·생맥주','고깃집','횟집·해산물','치킨','와인바','칵테일·위스키바','일반음식점','카페·디저트'];
    $('si-detail').innerHTML='<div class="si-eyebrow">STORE BRIEF</div><h2>'+esc(s.name)+'</h2><p>'+esc(s.addr)+'</p><div class="si-tags">'+tag(matchLabel(s),'warn')+tag('실제 오픈 '+({preparing:'준비 확인',open:'영업 확인',closed:'미영업 확인'}[r.opening]||'미확인'))+'</div>'+
      '<h3>영업 추천 근거</h3><ul>'+info.reasons.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p>신고: '+esc(s.typeLabel)+' / '+esc(s.upte||'미기재')+'<br>실제업태: '+esc(info.category.label)+'<br><small>'+esc(info.category.basis)+'</small></p>'+
      '<h3>매장 매칭 근거</h3><p>'+esc(I.labels[I.state(e)])+(e.score!=null?' · 규칙 '+e.score+'점':'')+'</p><ul>'+(e.reasons||['기존 판정은 주소 검증 없이 생성됐을 수 있어 재확인이 필요합니다.']).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><p class="si-note">인허가일은 개업일이 아닙니다. 동일 건물의 다른 층·호수와 이전 가게를 확인하세요. 매칭 점수는 정확도 %가 아닙니다.<br>검색 확인: '+esc(renderTime(e.checked_at||e.at))+'</p>'+
      candidates.map((c,i)=>'<p><b>후보 '+(i+1)+'. '+esc(c.title)+'</b> · '+c.score+'점<br>'+esc(c.address)+'<br><small>'+esc(c.conflicts.length?c.conflicts.join(' · '):c.category||'세부업태 미확인')+'</small></p>').join('')+
      '<div class="si-actions"><a class="si-btn" target="_blank" rel="noopener noreferrer" href="https://search.naver.com/search.naver?query='+search+'">네이버 비교</a><a class="si-btn" target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?q='+search+'">구글 비교</a><button type="button" id="si-recheck" class="si-btn">매칭 다시 확인</button>'+(s.tel?'<a class="si-btn" href="tel:'+esc(String(s.tel).replace(/[^0-9+()-]/g,''))+'">전화</a>':'')+'</div>'+
      '<p class="si-note">구글은 비교 검색 링크입니다. Google Places 자동 수집은 연결하지 않았습니다. 네이버 API는 전화번호·실제 개업일·매출을 제공하지 않습니다.</p>'+
      '<h3>확인 결과 · 영업 기록</h3>'+localNote()+'<form id="si-review" class="si-form"><label>매칭 검토<select name="match"><option value="">검토 전</option><option value="confirmed">동일 매장 확인</option><option value="rejected">다른 매장</option><option value="hold">보류</option></select></label><label>확인한 매장명·URL<input name="evidence" value="'+esc(r.evidence||'')+'" placeholder="직접 확인한 근거를 남겨주세요"></label><label>실제업태<select name="actualCategory">'+categoryOptions.map(x=>'<option value="'+esc(x)+'">'+esc(x||'추정 유지 · 미확인')+'</option>').join('')+'</select></label><label>실제 오픈 상태<select name="opening"><option value="">미확인</option><option value="preparing">오픈 준비 확인</option><option value="open">영업 확인</option><option value="closed">미영업 확인</option></select></label><label>영업 단계<select name="status">'+Object.entries(statuses).map(([k,v])=>'<option value="'+k+'">'+v+'</option>').join('')+'</select></label><label>담당자<input name="owner" value="'+esc(r.owner||'')+'" placeholder="담당 영업사원"></label><label>다음 연락일<input type="date" name="nextContact" value="'+esc(r.nextContact||'')+'"></label><label>메모<textarea name="note">'+esc(r.note||tr.note||'')+'</textarea></label><button class="si-btn primary" type="submit">확인 결과 저장 · 영업 추적</button><div class="si-feedback" id="si-feedback" role="status"></div></form>';
    const form=$('si-review');for(const k of ['match','actualCategory','opening','status'])form.elements[k].value=r[k]||(k==='status'?tr.status||'new':'');
    const back=document.createElement('button');back.className='si-btn si-mobile-back';back.type='button';back.textContent='← 매장 목록으로';back.onclick=()=>$('si-leads').scrollIntoView({behavior:'smooth',block:'start'});$('si-detail').prepend(back);
    form.onsubmit=ev=>{
      ev.preventDefault();const fields=Object.fromEntries(new FormData(form));
      if(fields.match==='confirmed'&&!fields.evidence.trim()){$('si-feedback').textContent='동일 매장을 확인한 근거(매장명·URL·현장 확인)를 입력해주세요.';return;}
      const next={...reviews,[s.id]:{...fields,at:new Date().toISOString(),sourceCheckedAt:e.checked_at||null}};
      try{localStorage.setItem(reviewKey,JSON.stringify(next));reviews=next;}catch(err){$('si-feedback').textContent='저장 공간 부족으로 저장하지 못했습니다.';return;}
      let t=ST.tracked.find(t=>t.id===s.id);if(!t){t={...s,trackedAt:new Date().toISOString(),snapshots:[]};ST.tracked.push(t);}
      Object.assign(t,{status:fields.status,note:fields.note,owner:fields.owner,nextContact:fields.nextContact});save();
      renderLeadRows();$('si-feedback').textContent='이 브라우저에 저장했습니다. 영업관리에서도 확인할 수 있습니다.';
    };
    $('si-recheck').onclick=async()=>{const button=$('si-recheck');button.disabled=true;button.textContent='주소·후보 비교 중…';try{await analyzeStore(s);save();renderLeadRows();}catch(err){button.textContent='확인 실패 · 다시 시도';button.disabled=false;}};
  }
  function renderTrends(){
    const data=window.YTD, loaded=data&&data.months_loaded||[];
    const cutoff=new Date(data&&data.at||Date.now());const yearMonth=new Date(+cutoff+9*3600000).toISOString().slice(0,7).replace('-','');
    const months=loaded.filter(m=>m<yearMonth).sort().slice(-2);
    if(months.length<2){$('si-content').innerHTML='<div class="si-panel si-empty">완료된 월 자료가 2개월 이상 필요합니다. 진행 중인 월을 지난달 전체와 비교하지 않습니다.</div>';return;}
    const buckets={},seen=new Set();let total=0,reviewed=0;
    Object.values(data.by_brand||{}).forEach(b=>months.forEach(m=>(b.monthly&&b.monthly[m]&&b.monthly[m].stores||[]).forEach(s=>{
      const key=(s.id||I.norm(s.name+' '+s.addr))+m;if(seen.has(key))return;seen.add(key);
      if(scope==='metro'&&!I.metro(s.addr))return;
      const cat=I.classify(s,entry(s),review(s));total++;if(cat.verified)reviewed++;
      if(!buckets[cat.label])buckets[cat.label]={prev:0,current:0,regions:new Set(),verified:0};
      const row=buckets[cat.label];row[m===months[0]?'prev':'current']++;if(m===months[1])row.regions.add(I.region(s.addr));if(cat.verified)row.verified++;
    })));
    const arr=Object.entries(buckets).sort((a,b)=>b[1].current-a[1].current);
    $('si-content').innerHTML='<div class="si-panel"><div class="si-panel-head"><h2>업태별 인허가 변화</h2><small>'+months[0]+' → '+months[1]+' · 완료월 비교</small></div><div class="si-toolbar" style="padding:0 16px"><label for="si-trend-scope">분석 권역</label><select id="si-trend-scope"><option value="metro">서울·경기·인천</option><option value="all">전국</option></select></div><div class="si-table-wrap"><table class="si-table"><thead><tr><th>실질 콘셉트 추정</th><th>'+months[0]+'</th><th>'+months[1]+'</th><th>증감</th><th>지역 수</th></tr></thead><tbody>'+arr.map(([cat,x])=>'<tr><td>'+esc(cat)+'<small>현장 업태 확인 '+x.verified+'건</small></td><td class="num">'+num(x.prev)+'</td><td class="num">'+num(x.current)+'</td><td class="num">'+(x.prev?((x.current-x.prev)/x.prev*100).toFixed(1)+'%':'신규 관측')+'</td><td class="num">'+x.regions.size+'</td></tr>').join('')+'</tbody></table></div></div><p class="si-note">'+num(total)+'개 인허가 기록 · 현장 업태 입력 '+num(reviewed)+'건. 기존 YTD 수집·제외 기준이 적용된 표본이며 전체 창업 시장 점유율이 아닙니다. 상호·장소 분류는 추정이며 인허가 증가가 매출 성장·실제 개업 증가를 뜻하지 않습니다. 폐업 누락 가능성 때문에 시장 전체 순증으로 표시하지 않습니다.</p><div class="si-actions"><button class="si-btn" id="si-trend-deep">기존 월별·폐업 분석 보기</button></div>';
    $('si-trend-scope').value=scope;$('si-trend-scope').onchange=e=>{scope=e.target.value;renderTrends();};$('si-trend-deep').onclick=()=>switchPage('trend');
  }
  function renderBrands(){
    const existing=view==='expand';
    const list=brands.filter(g=>{
      const customer=isCustomerBrand(g.brand), known=!!(window._franchiseSet||{})[I.norm(g.brand)];
      if(existing ? !(customer||known) : customer||known)return false;
      if(query&&!I.norm(g.brand).includes(I.norm(query)))return false;
      if(scope==='metro'&&!g.metrics.metro90)return false;
      return g.metrics.current90>0;
    });
    $('si-content').innerHTML='<div class="si-toolbar"><input type="search" id="si-brand-search" aria-label="브랜드 검색" placeholder="브랜드명 검색" value="'+esc(query)+'"><select id="si-brand-scope" aria-label="브랜드 범위"><option value="all">전국 · 지방 확산 포함</option><option value="metro">수도권 최근 인허가 있음</option></select></div>'+
      metrics([[num(list.length),existing?'기존 브랜드 후보':'신생·미분류 브랜드 후보'],[num(list.filter(x=>x.metrics.previous90>=3&&x.metrics.change>0).length),'직전 90일 대비 증가'],[num(list.filter(x=>x.metrics.signal.includes('→')).length),'지방 → 수도권 이동 관측'],[renderTime(window.YTD&&YTD.at),'브랜드 데이터 기준일']])+
      '<p class="si-note">'+(existing?'공정위 마스터에서 인식되거나 이 브라우저에서 거래 등록한 브랜드입니다. 브랜드 거래 등록은 전 지점 거래를 뜻하지 않으며, 미등록을 세왕 미거래로 단정하지 않습니다.':'공정위 마스터에서 인식되지 않고 거래 등록도 없는 다점포 후보입니다. 신규 브랜드·실제 가맹사업 여부는 본사 확인이 필요합니다.')+' 90일 실적은 실제 출점이 아닌 인허가 관측입니다. 표본 밖 오래된 지점은 누락될 수 있어 총 매장수·서울 진출 확률로 해석하지 않습니다.</p>'+
      '<div class="si-panel"><div class="si-panel-head"><h2>'+(existing?'확장 지점 · 본사 영업':'새롭게 관측된 다점포 브랜드')+'</h2><small>최근 90일 인허가순 · 상위 80개</small></div><div class="si-table-wrap"><table class="si-table"><thead><tr><th>브랜드 · 판단 근거</th><th>직전 90일</th><th>최근 90일</th><th>수도권</th><th>관측 폐업</th><th>거래 정보</th></tr></thead><tbody>'+list.slice(0,80).map((g,i)=>'<tr><td><button data-brand-index="'+i+'"><b>'+esc(g.brand)+'</b><small>'+esc(g.metrics.signal)+'</small></button></td><td class="num">'+g.metrics.previous90+'</td><td class="num">'+g.metrics.current90+'<small>'+(g.metrics.previous90>=3?(g.metrics.change>0?'+':'')+g.metrics.change+'%':'작은 표본 · 비율 생략')+'</small></td><td class="num">'+g.metrics.metro90+'</td><td class="num">'+g.metrics.closed90+'</td><td>'+tag(isCustomerBrand(g.brand)?'거래 등록 있음':'거래 여부 미입력',isCustomerBrand(g.brand)?'good':'')+'</td></tr>').join('')+'</tbody></table></div>'+(list.length?'':'<div class="si-empty">현재 조건의 브랜드가 없습니다. 전국으로 범위를 넓히거나 데이터 로딩 상태를 확인하세요.</div>')+'</div><aside id="si-brand-detail" class="si-panel si-detail" style="position:static;margin-top:16px"><p>브랜드명을 누르면 지역 이동 근거와 기존 상세 분석을 확인할 수 있습니다.</p></aside>';
    $('si-brand-scope').value=scope;
    $('si-brand-scope').onchange=e=>{scope=e.target.value;renderBrands();};
    $('si-brand-search').onchange=e=>{query=e.target.value;renderBrands();};
    $('si-content').querySelectorAll('[data-brand-index]').forEach(b=>b.onclick=()=>{
      const g=list[Number(b.dataset.brandIndex)];const m=g.metrics;
      $('si-brand-detail').innerHTML='<div class="si-eyebrow">BRAND BRIEF</div><h2>'+esc(g.brand)+'</h2><p>'+esc(m.signal)+'</p><div class="si-tags">'+Object.entries(m.firstRegions).sort((a,b)=>a[1].localeCompare(b[1])).map(([r,d])=>tag(r+' '+fmtYmd(d))).join('')+'</div><p class="si-note">표시일은 수집된 표본에서 해당 지역이 처음 관측된 인허가일입니다. 브랜드 창업일이나 진출일 확정이 아닙니다. 순증·생존율·지점별 세왕 거래율은 전체 지점명부와 거래처 연결 후 계산해야 합니다.</p><div class="si-actions"><button id="si-open-brand" class="si-btn primary">지점 목록 · 기존 상세 분석</button><button id="si-mark-brand" class="si-btn">'+(isCustomerBrand(g.brand)?'거래 등록 확인됨':'거래 브랜드로 기록')+'</button></div>'+localNote();
      $('si-open-brand').onclick=()=>{switchPage('fr');selectBrand(encodeURIComponent(g.brand),true);};
      $('si-mark-brand').onclick=()=>{if(!isCustomerBrand(g.brand)){const arr=loadCustomers();arr.push(g.brand);saveCustomers(arr);renderBrands();}};
    });
  }
  function mount(){
    if(!window.ME||$('si-workspace'))return;
    reviewKey='sewang-evidence-v18-'+String(ME.kakao_id||ME.id||ME.nickname||'local');
    try{reviews=JSON.parse(localStorage.getItem(reviewKey)||'{}');}catch(e){reviews={};}
    if(!reviews||Array.isArray(reviews)||typeof reviews!=='object')reviews={};
    const home=$('pg-home');const legacy=document.createElement('details');legacy.className='si-legacy';
    const summary=document.createElement('summary');summary.textContent='기존 통계 · SNS · 세부 분석 펼치기';legacy.append(summary);
    const grid=document.createElement('div');grid.className='si-legacy-grid';while(home.firstChild)grid.append(home.firstChild);legacy.append(grid);home.append(legacy);
    const host=document.createElement('section');host.id='si-workspace';host.className='si-workspace';home.prepend(host);
    if(ME.role==='owner'){host.remove();legacy.open=true;return;} // preserve original restricted audience
    legacy.addEventListener('toggle',()=>{if(legacy.open)try{renderCharts();}catch(e){}});
    const nav=document.querySelector('.bnav');
    const names={home:'영업 홈',new:'신규 매장',fr:'브랜드',track:'영업관리'};
    nav.querySelectorAll('[data-pg]').forEach(b=>{if(names[b.dataset.pg])b.childNodes.forEach(n=>{if(n.nodeType===3&&n.textContent.trim())n.textContent=names[b.dataset.pg];});});
    const more=document.createElement('button');more.className='bnav-btn si-more-toggle';more.type='button';more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls','si-more');more.innerHTML='<span class="ico">···</span>더보기';nav.append(more);
    const menu=document.createElement('div');menu.className='si-more';menu.id='si-more';menu.hidden=true;
    [['trend','창업 추이'],['insight','SNS 인사이트'],['map','영업 지도'],...(ME.role==='admin'?[['admin','관리자']]:[])].forEach(([pg,label])=>{const b=document.createElement('button');b.textContent=label;b.onclick=()=>{switchPage(pg);menu.hidden=true;more.setAttribute('aria-expanded','false');};menu.append(b);});
    document.body.append(menu);more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));};
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;more.setAttribute('aria-expanded','false');}});
    render();
  }
  window.mountIntelligence=mount;
  window.renderIntelligence=render;
})();
