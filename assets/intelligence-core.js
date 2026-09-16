/* Shared, deterministic evidence rules. Scores are rule points, NOT probabilities. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SewangIntelligence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 2;
  const DAY = 86400000;
  const labels = { matched:'동일 매장 유력', candidate:'후보 검토', ambiguous:'복수 후보', no_result:'검색 결과 없음', error:'검색 오류', unknown:'미확인', legacy:'기존 판정 · 재검증 필요' };
  function text(v) { return String(v || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').normalize('NFKC').trim(); }
  function norm(v) { return text(v).toLowerCase().replace(/[\s㈜()\[\]·.,_-]/g, '').replace(/주식회사/g, ''); }
  function date(v) {
    const s = String(v || '').replace(/[^0-9]/g, '').slice(0,8);
    if (s.length !== 8) return null;
    const d = new Date(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8)+'T00:00:00+09:00');
    return Number.isFinite(+d) ? +d : null;
  }
  function age(v, now) { const d = date(v); return d === null ? null : Math.floor(((now == null ? Date.now() : now) - d) / DAY); }
  function region(v) {
    const s = text(v);
    const list = [['서울','서울'],['경기','경기'],['인천','인천'],['부산','부산'],['대구','대구'],['대전','대전'],['울산','울산'],['광주','광주'],['세종','세종'],['강원','강원'],['충청북','충북'],['충북','충북'],['충청남','충남'],['충남','충남'],['전라북','전북'],['전북','전북'],['전라남','전남'],['전남','전남'],['경상북','경북'],['경북','경북'],['경상남','경남'],['경남','경남'],['제주','제주']];
    return (list.find(p => s.startsWith(p[0])) || ['', '미상'])[1];
  }
  function metro(v) { return ['서울','경기','인천'].includes(region(v)); }
  function address(v) {
    const s = text(v).replace(/\s+/g,' ');
    const road = s.match(/([가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+(\d+(?:-\d+)?)/);
    const lot = s.match(/([가-힣0-9]+(?:동|읍|면|리))\s+(산\s*)?(\d+(?:-\d+)?)/);
    const floor = s.match(/(?:지하\s*(\d+)\s*층?|B\s*(\d+)(?!\d)|(-?\d+)\s*층)/i);
    const unit = s.match(/(\d+[A-Za-z]?)\s*호/);
    const district = (s.match(/([가-힣]+(?:시|군|구))(?=\s)/g) || []).filter(x=>!/(특별|광역|자치)/.test(x)).join(' ');
    return { region:region(s), district, road:road ? norm(road[1])+':'+road[2] : '', lot:lot ? norm(lot[1])+':'+(lot[2]?'산':'')+lot[3] : '', floor:floor ? String(floor[1] ? -Number(floor[1]) : floor[2] ? -Number(floor[2]) : Number(floor[3])) : '', unit:unit ? unit[1].toLowerCase() : '', raw:norm(s) };
  }
  function similarity(a,b) {
    a=norm(a); b=norm(b); if(!a || !b) return 0; if(a===b) return 1;
    if(Math.min(a.length,b.length)>=4 && (a.includes(b)||b.includes(a))) return .86;
    const pairs = s => new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));
    const aa=pairs(a), bb=pairs(b); let n=0; aa.forEach(x=>{if(bb.has(x)) n++;});
    return aa.size+bb.size ? 2*n/(aa.size+bb.size) : 0;
  }
  function assess(store, item) {
    const a=address(store.addr), alternatives=[address(item.roadAddress), address(item.address)].filter(x=>x.raw);
    let b=alternatives.find(x=>a.road && x.road===a.road) || alternatives.find(x=>a.lot && x.lot===a.lot) || alternatives[0] || address('');
    const reasons=[], conflicts=[]; let score=0;
    const name=similarity(store.name,item.title);
    if(name>=.99){score+=45;reasons.push('상호 일치');}else if(name>=.8){score+=34;reasons.push('상호 핵심 일치');}else if(name>=.5){score+=18;reasons.push('상호 일부 유사');}
    const sameBuilding=!!((a.road&&a.road===b.road)||(a.lot&&a.lot===b.lot)||(a.raw&&a.raw===b.raw));
    if(sameBuilding){score+=40;reasons.push('주소 건물 일치');}
    if(a.region!=='미상' && b.region!=='미상' && a.region!==b.region)conflicts.push('시·도 불일치');
    if(a.district&&b.district&&a.district!==b.district)conflicts.push('시·군·구 불일치');
    if(a.road&&b.road&&a.road!==b.road)conflicts.push('도로명·건물번호 불일치');
    // All returned address variants may contain floor/unit information.
    for(const key of ['floor','unit']) {
      const candidates=alternatives.map(x=>x[key]).filter(Boolean);
      if(a[key] && candidates.length){
        if(candidates.includes(a[key])){score+=key==='unit'?10:5;reasons.push(key==='unit'?'호수 일치':'층 일치');}
        else conflicts.push(key==='unit'?'호수 불일치':'층 불일치');
      }
    }
    if(!sameBuilding) reasons.push('동일 건물 확인 필요');
    if(sameBuilding&&!a.unit&&!b.unit)reasons.push('복합상가·동일 주소 교체매장 주의');
    return {title:text(item.title),address:text(item.roadAddress||item.address),category:text(item.category),url:/^https?:\/\//i.test(item.link||'')?item.link:'',score:Math.min(score,100),nameSimilarity:name,sameBuilding,regionMatch:a.region!=='미상'&&a.region===b.region,reasons,conflicts};
  }
  function match(store, items, error) {
    const out={version:VERSION,status:'unknown',score:null,candidates:[],reasons:[],checked_at:new Date().toISOString(),found:null};
    if(error){out.status='error';out.reasons=['검색 실패 · 미등록으로 판정하지 않음'];return out;}
    if(!Array.isArray(items)){out.status='error';out.reasons=['응답 형식 오류'];return out;}
    const seen=new Set();
    out.candidates=items.map(i=>assess(store,i)).filter(c=>{const k=norm(c.title)+'|'+norm(c.address);if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>(a.conflicts.length>0)-(b.conflicts.length>0)||b.score-a.score).slice(0,5);
    if(!out.candidates.length){out.status='no_result';out.found=false;out.reasons=['검색 범위에서 결과 없음 · 미등록·미오픈 확정 아님'];return out;}
    const best=out.candidates[0], second=out.candidates[1];
    out.score=best.score;out.reasons=best.reasons.concat(best.conflicts);
    const eligible=best.sameBuilding && best.regionMatch && best.nameSimilarity>=.8 && !best.conflicts.length && best.score>=74;
    if(eligible && second && !second.conflicts.length && second.score>=best.score-12){out.status='ambiguous';out.reasons.push('상위 후보 점수 차이 작음');}
    else if(eligible){out.status='matched';out.found=true;out.place=best;}
    else out.status='candidate';
    return out;
  }
  function state(entry) {
    if(!entry)return 'unknown';
    if(entry.version===VERSION && labels[entry.status])return entry.status;
    return 'legacy';
  }
  function isUnresolved(entry) { return ['no_result','candidate','ambiguous'].includes(state(entry)); }
  function queries(s) {
    const a=address(s.addr), head=text(s.addr).split(',')[0].replace(/\([^)]*\)/g,'').trim();
    return [...new Set([text(s.name)+' '+a.region+' '+a.district,text(s.name)+' '+head].map(x=>x.trim()))].filter(Boolean);
  }
  const categories=[
    ['이자카야',/이자카야|선술집|사케바|로바타/,30],['한식주점',/한식주점|전통주|막걸리|주막|전집/,30],['포차·주점',/포차|포장마차|술집|주점/,30],
    ['호프·생맥주',/호프|생맥주|맥주|비어|펍/,30],['와인바',/와인바|와인.*바/,27],['칵테일·위스키바',/칵테일|위스키|라운지|혼술바/,27],
    ['고깃집',/고기|갈비|삼겹|곱창|막창|숯불|식육/,25],['횟집·해산물',/횟집|회집|수산|해산물|조개|참치|대게/,25],['치킨',/치킨|통닭/,23],
    ['카페·디저트',/카페|커피|베이커리|제과|디저트|아이스크림/,3]
  ];
  function classify(s, entry, review) {
    if(review&&review.actualCategory){const known=categories.find(c=>c[0]===review.actualCategory);return {label:review.actualCategory,basis:'현장 입력',points:known?known[2]:12,verified:true};}
    if(s.type==='danran'||s.type==='yuheung')return {label:s.type==='danran'?'단란주점':'유흥주점',basis:'인허가 업종',points:30,verified:false};
    const place=state(entry)==='matched' && !(review&&review.match==='rejected') ? entry.place : null;
    const signals=[place&&place.category,text(s.name),text(s.upte)].filter(Boolean);
    for(let i=0;i<signals.length;i++){
      const c=categories.find(c=>c[1].test(signals[i]));
      if(c)return {label:c[0],basis:place&&i===0?'장소 분류 기반 추정':'상호·신고업태 기반 추정',points:c[2],verified:false};
    }
    return {label:'음식점·세부업태 미확인',basis:'추가 확인 필요',points:12,verified:false};
  }
  function lead(s, entry, review, now) {
    const cat=classify(s,entry,review), days=age(s.permitDate,now), reasons=[];
    let score=cat.points;
    reasons.push(cat.label);
    if(metro(s.addr)){score+=25;reasons.push('수도권');}
    if(days!==null&&days>=0&&days<=7){score+=25;reasons.push('인허가 7일 이내');}
    else if(days!==null&&days>=0&&days<=30){score+=15;reasons.push('인허가 30일 이내');}
    if(text(s.tel)){score+=10;reasons.push('인허가 연락처 있음');}
    if(review&&['preparing','open'].includes(review.opening)){score+=10;reasons.push('현장 확인');}
    if(s.closed||s.closedDate||/폐업|취소/.test(s.status||'')||(review&&review.opening==='closed')){score=0;reasons.push('폐업·미영업 기록');}
    return {score,category:cat,reasons,days,matchStatus:state(entry)};
  }
  function nextCheck(s, entry, now) {
    now=now==null?Date.now():now;
    const days=age(s.permitDate,now), checked=Date.parse(entry&&entry.checked_at||'');
    if(days===null||days<0||days>180)return null;
    if(!entry||!Number.isFinite(checked))return now;
    if(state(entry)==='legacy')return checked+DAY; // migrate old permanent registrations
    if(state(entry)==='error')return checked+DAY;
    if(state(entry)==='matched')return checked+30*DAY;
    const pd=date(s.permitDate);
    const milestone=[0,3,7,14,30,60].map(n=>pd+n*DAY).find(t=>t>checked);
    return milestone || checked+30*DAY;
  }
  function brandMetrics(stores, asOf) {
    const now=asOf==null?Date.now():asOf, seen=new Set();
    const rows=(stores||[]).filter(s=>{const k=s.id || norm(s.name)+'|'+norm(s.addr)+'|'+s.permitDate;if(seen.has(k))return false;seen.add(k);return true;});
    const last=rows.filter(s=>{const d=age(s.permitDate,now);return d!==null&&d>=0&&d<90;});
    const prev=rows.filter(s=>{const d=age(s.permitDate,now);return d!==null&&d>=90&&d<180;});
    const closings=rows.filter(s=>{const d=age(s.closedDate,now);return d!==null&&d>=0&&d<90;}).length;
    const sequence=rows.filter(s=>date(s.permitDate)!==null&&date(s.permitDate)<=now).sort((a,b)=>date(a.permitDate)-date(b.permitDate));
    const first={};sequence.forEach(s=>{const r=region(s.addr);if(r!=='미상'&&!first[r])first[r]=s.permitDate;});
    const local=Object.keys(first).filter(r=>!['서울','경기','인천'].includes(r));
    const firstMetro=sequence.find(s=>metro(s.addr));
    const beforeMetro=firstMetro ? Object.entries(first).filter(([r,d])=>!['서울','경기','인천'].includes(r)&&date(d)<date(firstMetro.permitDate)).length : 0;
    const signal=beforeMetro>=2 && last.some(s=>metro(s.addr)) ? '지방 다지역 → 수도권 진입 관측' : local.length>=2 && !firstMetro ? '지방 다지역 확산 · 수도권 미관측' : last.filter(s=>metro(s.addr)).length>=3 ? '수도권 인허가 증가' : '추가 관측 필요';
    return {current90:last.length,previous90:prev.length,change:prev.length?Math.round((last.length-prev.length)/prev.length*100):null,closed90:closings,observedNet:last.length-closings,metro90:last.filter(s=>metro(s.addr)).length,signal,firstRegions:first,stores:rows};
  }
  return {VERSION,DAY,labels,text,norm,date,age,region,metro,address,similarity,assess,match,state,isUnresolved,queries,classify,lead,nextCheck,brandMetrics};
});
