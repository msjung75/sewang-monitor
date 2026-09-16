/* Persistent recovery/loading notices outside rerendered dashboard content. */
(function(){
  'use strict';
  const labels={'trend30_all.json':'최근 인허가','ytd_2026_summary.json':'올해 누적 분석','customers_hash.json':'공유 거래처'};
  let recoveryNotice='',recoveryFailed=false;
  function notices(){
    const main=document.querySelector('.main');
    if(!main || !window.ME || !['admin','staff','sales','viewer','owner'].includes(ME.role))return;
    let host=document.getElementById('app-data-notices');
    if(!host){host=document.createElement('section');host.id='app-data-notices';host.className='si-data-notices';host.setAttribute('aria-label','자료 상태와 기록 복구');main.prepend(host);}
    host.replaceChildren();
    const legacy=SewangRecovery.inspect(localStorage,ME);
    if(legacy.status==='available' || recoveryNotice || recoveryFailed || legacy.status==='unreadable'){
      const box=document.createElement('div');box.className='si-data-notice';
      const text=document.createElement('p');
      text.textContent=recoveryFailed?'복구 내용을 저장하지 못했습니다. 기존 원본은 그대로 보존했습니다. 브라우저 데이터를 지우지 말고 지원을 요청해 주세요.':recoveryNotice|| (legacy.status==='unreadable'?'기존 브라우저 기록을 읽지 못했습니다. 데이터를 지우지 말고 지원을 요청해 주세요.':'이 기기에 이전 버전 기록이 남아 있습니다. 추적 매장 '+legacy.counts.tracked+'건 · 거래 브랜드 '+legacy.counts.brands+'개 · 거래처 매장 '+legacy.counts.stores+'곳. 본인이 이 기기에 저장한 기록이면 현재 계정으로 복구하세요. 기존 원본과 현재 기록은 보존됩니다.');
      box.append(text);
      if(legacy.status==='available'){
        const button=document.createElement('button');button.id='restore-device-records';button.type='button';button.className='si-btn primary';button.textContent='이 기기의 내 기록 복구';
        button.onclick=()=>{
          button.disabled=true;
          const result=SewangRecovery.restore(localStorage,ME,true);
          recoveryFailed=!result.restored;
          if(result.restored){
            recoveryNotice='기존 기록을 복구했습니다. 추적 매장·메모는 영업관리에서, 거래처는 기존 거래 정보에서 확인할 수 있습니다. 원본도 이 기기에 보존했습니다.';
            const records=JSON.parse(appStorageGetItem('sewang-v12'));
            ST.tracked=records.tracked;ST.me=ME;
            document.dispatchEvent(new CustomEvent('sewang:records-restored'));
            [window.renderTracked,window.renderCustomers,window.renderNew,window.renderStats,window.renderIntelligence].forEach(fn=>{if(typeof fn==='function')try{fn();}catch{}});
          }
          notices();
        };
        box.append(button);
      }
      host.append(box);
    }
    const statuses=window.APP_DATA_STATE||{},files=Object.keys(labels).filter(f=>ME.role!=='owner'||f!=='customers_hash.json');
    const failed=files.filter(f=>['error','denied','session-expired'].includes(statuses[f]));
    const loading=files.filter(f=>statuses[f]==='loading');
    if(failed.length||loading.length){
      const box=document.createElement('div');box.className='si-data-notice'+(failed.length?' error':'');box.setAttribute('role','status');
      const text=document.createElement('p');
      text.textContent=failed.length?failed.map(f=>labels[f]).join(' · ')+' 자료를 불러오지 못했습니다. 삭제 또는 0건을 의미하지 않습니다. 이전에 불러온 자료가 있으면 그대로 표시합니다.' : loading.map(f=>labels[f]).join(' · ')+' 자료를 불러오고 있습니다…';
      box.append(text);
      if(failed.length){
        const retry=document.createElement('button');retry.type='button';retry.className='si-btn';
        const expired=failed.some(f=>statuses[f]==='session-expired');
        retry.textContent=expired?'로그인 다시 확인':'자료 다시 불러오기';
        retry.onclick=()=>{if(expired){location.reload();return;}if(failed.includes('trend30_all.json'))loadNightlyCache();if(failed.includes('ytd_2026_summary.json'))loadYTDSummary();document.dispatchEvent(new CustomEvent('sewang:retry-data'));};
        box.append(retry);
      }
      host.append(box);
    }
    host.hidden=!host.childNodes.length;
  }
  document.addEventListener('sewang:account-ready',notices);
  document.addEventListener('sewang:data-state',notices);
})();
