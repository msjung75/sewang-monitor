/* Authenticated, bounded snapshot transfer, independent of proxy gzip headers. */
(function(){
  'use strict';
  const active=new Map();
  let resolveAccount;
  const accountReady=new Promise(resolve=>{resolveAccount=resolve;});
  window.APP_DATA_STATE={};
  window.setAppDataUser=user=>resolveAccount(user);
  window.setAppDataState=function(file,state){
    window.APP_DATA_STATE[file]=state;
    document.dispatchEvent(new CustomEvent('sewang:data-state',{detail:{file,state}}));
  };
  function failure(status,message){const e=new Error(message||'자료를 불러오지 못했습니다.');e.status=status;return e;}
  async function request(url,options){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try{
      const response=await fetch(url.toString(),{...options,cache:'no-store',credentials:'same-origin',signal:controller.signal});
      if(!response.ok)throw failure(response.status);
      return await response.json();
    }finally{clearTimeout(timer);}
  }
  async function decode(url,options){
    const manifest=await request(url,options);
    if(!manifest || manifest._sewangSnapshot!==1)return manifest;
    const m=manifest;
    if(!Number.isInteger(m.parts)||m.parts<1||m.parts>100||!Number.isInteger(m.bytes)||m.bytes<1||m.bytes>100000000||!Number.isInteger(m.decodedBytes)||m.decodedBytes<1||m.decodedBytes>100000000||!['gzip','identity'].includes(m.encoding)||!/^[a-f0-9]{64}$/.test(m.revision))throw failure(502,'자료 구성을 확인할 수 없습니다.');
    const chunks=new Array(m.parts);
    // Three parallel reads keep transfer bounded and retain permission checks on every part.
    for(let start=0;start<m.parts;start+=3){
      await Promise.all(Array.from({length:Math.min(3,m.parts-start)},async(_,offset)=>{
        const part=start+offset,partUrl=new URL(url);
        partUrl.searchParams.set('part',part);partUrl.searchParams.set('revision',m.revision);
        const chunk=await request(partUrl,options);
        if(chunk.revision!==m.revision||chunk.part!==part||typeof chunk.data!=='string'||chunk.data.length>1333336)throw failure(502,'자료 일부가 일치하지 않습니다.');
        chunks[part]=Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0));
      }));
    }
    const size=chunks.reduce((n,x)=>n+x.length,0);
    if(size!==m.bytes)throw failure(502,'자료 일부가 누락되었습니다.');
    let bytes=new Uint8Array(size),at=0;
    for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    if(m.encoding==='gzip'){
      const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const decoded=[];let total=0;
      for(;;){const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>m.decodedBytes){await reader.cancel();throw failure(502);}decoded.push(part.value);}
      bytes=new Uint8Array(total);at=0;for(const chunk of decoded){bytes.set(chunk,at);at+=chunk.length;}
    }
    if(bytes.length!==m.decodedBytes)throw failure(502,'자료 크기가 일치하지 않습니다.');
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    const hash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
    if(hash!==m.revision)throw failure(502,'자료 검증에 실패했습니다.');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  window.fetchAppData=async function(input,options={}){
    const url=new URL(input,location.origin);
    if(url.origin!==location.origin||!url.pathname.startsWith('/data/'))throw failure(400);
    const user=await accountReady;
    if(!user || !['admin','staff','sales','viewer','owner'].includes(user.role))throw failure(401);
    const file=url.pathname.slice(6);
    if(!active.has(file)){
      url.searchParams.set('transport','chunks');
      url.searchParams.set('encoding',typeof DecompressionStream==='function'?'gzip':'identity');
      window.setAppDataState(file,'loading');
      const work=(async()=>{
        try{
          let data;
          try{data=await decode(url,options);}catch(e){if(e.status!==409)throw e;data=await decode(url,options);}
          window.setAppDataState(file,'ready');return data;
        }catch(e){window.setAppDataState(file,e.status===401?'session-expired':e.status===403?'denied':'error');throw e;}
        finally{active.delete(file);}
      })();
      active.set(file,work);
    }
    const data=await active.get(file);
    return {ok:true,status:200,json:async()=>data,headers:{get:()=>null}};
  };
})();
