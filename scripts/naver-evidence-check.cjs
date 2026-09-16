/* Uses the same evidence rules as the browser. Existing cron schedule is unchanged. */
const fs=require('node:fs');
const path=require('node:path');
const I=require('../assets/intelligence-core.js');
const CACHE='data/naver_nstat_cache.json';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function queueFor(stores,cache,now){
  return stores.filter(s=>{const due=I.nextCheck(s,cache[s.id],now);return due!==null&&due<=now&&!s.closedDate&&!/폐업|취소/.test(s.status||'');}).sort((a,b)=>{
    const priority=s=>(I.metro(s.addr)?100:0)+((I.age(s.permitDate,now)<=30)?50:0)+(I.state(cache[s.id])==='unknown'?25:0);
    return priority(b)-priority(a)||(Date.parse(cache[a.id]&&cache[a.id].checked_at)||0)-(Date.parse(cache[b.id]&&cache[b.id].checked_at)||0);
  });
}
async function collectStore(s,request){
  let items=[], result;
  for(const q of I.queries(s)){
    const d=await request(q);
    if(!Array.isArray(d.items))throw new Error('invalid_response');
    items.push(...d.items);result=I.match(s,items);
    if(result.status==='matched')break;
  }
  return {...(result||I.match(s,[])),source:'naver-local',name:s.name,queries:I.queries(s)};
}
async function main(){
  const id=process.env.NAVER_CLIENT_ID,secret=process.env.NAVER_CLIENT_SECRET;
  if(!id||!secret){console.log('NAVER credentials not configured; no changes.');return;}
  const budget=Math.max(1,Math.min(10000,parseInt(process.env.NAVER_DAILY_LIMIT||'5000',10)||5000));
  const cache=read(CACHE,{}),stores=new Map();
  // Bounded to available YTD folders, no fixed calendar year.
  const dirs=fs.readdirSync('data').filter(x=>/^ytd_\d{4}$/.test(x));
  dirs.forEach(dir=>fs.readdirSync(path.join('data',dir)).filter(f=>f.endsWith('.json')).sort().forEach(file=>{
    const d=read(path.join('data',dir,file),{});for(const s of d.stores||[])if(s.id)stores.set(s.id,s);
  }));
  for(const s of read('data/trend30_all.json',{}).stores||[])if(s.id)stores.set(s.id,s);
  const now=Date.now(),today=new Date(now+9*3600000).toISOString().slice(0,10);
  // Per-day request usage travels in the existing cache file across retry workflows.
  const usage=cache._request_budget&&cache._request_budget.day===today?cache._request_budget:{day:today,calls:0};
  let calls=usage.calls||0,processed=0,errors=0,stop=false;
  async function request(q){
    if(calls>=budget)throw new Error('budget');
    calls++;await pause(150);
    const url='https://openapi.naver.com/v1/search/local.json?display=5&start=1&sort=random&query='+encodeURIComponent(q);
    const response=await fetch(url,{headers:{'X-Naver-Client-Id':id,'X-Naver-Client-Secret':secret},signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('http_'+response.status);
    return response.json();
  }
  const queue=queueFor([...stores.values()],cache,now);
  for(const s of queue){
    if(calls>=budget)break;
    try{
      const result=await collectStore(s,request),previous=cache[s.id];
      cache[s.id]={...result,nstat:result.status==='matched'?'registered':'unknown',
        history:[...(previous&&previous.history||[]),...(previous&&previous.checked_at?[{at:previous.checked_at,status:I.state(previous)}]:[])].slice(-8)};
      processed++;
    }catch(e){
      errors++;
      // An incomplete search is not a negative result. Stop on auth/rate-limit failures.
      if(['budget','http_401','http_403','http_429'].includes(e.message)){stop=true;break;}
      cache[s.id]={...I.match(s,[],true),name:s.name,previousStatus:I.state(cache[s.id])};
    }
    if(processed && processed%100===0)console.log(JSON.stringify({processed,calls,errors}));
  }
  cache._request_budget={day:today,calls};
  const tmp=CACHE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(cache));fs.renameSync(tmp,CACHE);
  console.log(JSON.stringify({queued:queue.length,processed,calls,errors,stopped:stop,version:I.VERSION}));
}
module.exports={queueFor,collectStore,main};
if(require.main===module)main().catch(e=>{console.error('Naver evidence job failed:',e.message);process.exitCode=1;});
