/* Local-only test harness: synthetic identity, no external calls, no live auth bypass.
   NEVER use as a deployment server. It binds only loopback and serves an explicit allowlist. */
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const I=require('../assets/intelligence-core.js');
const root=path.resolve(__dirname,'..');
const stamp=new Date().toISOString();
const ymd=n=>new Date(Date.now()-n*I.DAY).toISOString().slice(0,10).replace(/-/g,'');
const stores=Array.from({length:12},(_,i)=>({id:'test-'+i,name:['테스트 달빛주막','테스트 숯불마당','테스트 항구포차','테스트 가정식당'][i%4]+' '+(i+1)+'호점',addr:(i%3?'서울특별시 강남구 테헤란로':'부산광역시 해운대구 해운대로')+' '+(12+i)+', 2층 201호',type:'ilban',typeLabel:'일반음식점',upte:'기타',permitDate:ymd(i+1),status:'영업',tel:'',closedDate:''}));
const nstat={};stores.forEach((s,i)=>{if(i%3===0)nstat[s.id]=I.match(s,[]);if(i%3===1)nstat[s.id]=I.match(s,[{title:s.name,roadAddress:s.addr,category:'음식점>한식주점'}]);if(i%3===2)nstat[s.id]={nstat:'registered',checked_at:stamp};});
const byBrand={},months=new Set();for(let b=0;b<4;b++){const monthly={};for(let j=0;j<8;j++){const d=ymd(j*25+b),m=d.slice(0,6);months.add(m);if(!monthly[m])monthly[m]={open:0,closed:0,stores:[]};monthly[m].stores.push({...stores[b],id:'brand-'+b+'-'+j,permitDate:d});monthly[m].open++;}byBrand['테스트 브랜드 '+b]={monthly,total_open:8,total_closed:0};}
const byMonth={};months.forEach(m=>byMonth[m]={open:4,closed:0});
const ytd={at:stamp,year:new Date().getFullYear(),months_loaded:[...months].sort(),by_brand:byBrand,by_month:byMonth,by_sido:{},by_upte:{},closure_analysis:{}};
const data={'/data/trend30_all.json':{at:stamp,stores,byDay:{},count:stores.length,failures:0},'/data/naver_nstat_cache.json':nstat,'/data/ytd_2026_summary.json':ytd,'/data/brand_overrides.json':{},'/data/franchise_master.json':{brands:[]}};
const assets=new Set(['/assets/intelligence-core.js','/assets/intelligence-ui.js','/assets/intelligence.css','/icon.svg','/manifest.json']);
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
 if(u.pathname==='/frames'){
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>Responsive test frames · synthetic data only</h1><p><button onclick="document.getElementById(\'device\').style.width=\'390px\'">Folded 390</button><button onclick="document.getElementById(\'device\').style.width=\'768px\'">Unfolded 768</button><button onclick="document.getElementById(\'device\').style.width=\'1280px\'">Desktop 1280</button></p><iframe id="device" title="Responsive app" src="/" style="width:768px;height:900px;border:1px solid #889"></iframe>');return;
 }
 if(u.pathname==='/'){
   let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
   html=html.replace(/<script[^>]*src="(?:https?:)?\/\/[^>]+><\/script>/g,'');
   html=html.replace('window.ME = null;','window.ME = null;');
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;
 }
 if(u.pathname==='/api/auth/kakao'&&u.searchParams.get('action')==='me'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,user:{id:'local-fixture',nickname:'테스트 사용자',role:'staff'}}));return;}
 if(u.pathname==='/api/local'){res.setHeader('Content-Type','application/json');const q=u.searchParams.get('query')||'';res.end(JSON.stringify({items:stores.filter(s=>q.includes(s.name)).map(s=>({title:s.name,roadAddress:s.addr,category:'음식점>한식주점'}))}));return;}
 if(assets.has(u.pathname)){res.setHeader('Content-Type',u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':u.pathname.endsWith('.svg')?'image/svg+xml':'application/json');res.end(fs.readFileSync(path.join(root,u.pathname)));return;}
 if(u.pathname==='/sw.js'){res.writeHead(404);res.end('No service worker in fixture test');return;}
 if(data[u.pathname]){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data[u.pathname]));return;}
 if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/data/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[],brands:[],stores:[],error:'fixture: external source not connected'}));return;}
 res.writeHead(404);res.end('Not found');
}).listen(4173,'127.0.0.1',()=>console.log('Local fixture preview http://127.0.0.1:4173; responsive frames /frames'));
