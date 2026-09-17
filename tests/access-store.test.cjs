const {test}=require('node:test');
const assert=require('node:assert/strict');

function fixture(){
 const values=new Map();
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  const [command,key,value]=JSON.parse(options.body);
  let result=null;
  if(command==='PING')result='PONG';
  if(command==='GET')result=values.has(key)?values.get(key):null;
  if(command==='SET'){values.set(key,value);result='OK';}
  return {ok:true,json:async()=>({result})};
 };
 return {values,calls,options:{env:{UPSTASH_REDIS_REST_URL:'https://fixture.upstash.io',UPSTASH_REDIS_REST_TOKEN:'secret'},fetcher}};
}

test('private access storage keeps applicants and approved users outside repository files',async()=>{
 const store=await import('../lib/access-store.mjs');const f=fixture();
 assert.deepEqual(await store.privateAccessHealth(f.options),{configured:true,connected:true});
 assert.equal(await store.readPrivatePending(f.options),null);
 const pending={pending:[{id:'123',nickname:'신규 사용자'}],updated_at:'now'};
 await store.writePrivatePending(pending,f.options);
 assert.deepEqual(await store.readPrivatePending(f.options),pending);
 const access={users:[{id:'123',role:'viewer'}],blocked:[],updated_at:'now'};
 await store.writePrivateAccess(access,f.options);
 assert.deepEqual(await store.readPrivateAccess(f.options),access);
 assert.ok(f.calls.every(call=>call.url==='https://fixture.upstash.io'));
 assert.ok(f.calls.every(call=>call.options.headers.Authorization==='Bearer secret'));
});

test('missing, insecure and failed private storage report unavailable without falling back to public writes',async()=>{
 const store=await import('../lib/access-store.mjs');
 assert.equal(store.privateAccessConfigured({env:{}}),false);
 assert.equal(store.privateAccessConfigured({env:{KV_REST_API_URL:'http://redis.invalid',KV_REST_API_TOKEN:'x'}}),false);
 await assert.rejects(store.writePrivatePending({pending:[]},{env:{}}),/auth_storage_unavailable/);
 const options={env:{KV_REST_API_URL:'https://fixture.upstash.io',KV_REST_API_TOKEN:'x'},fetcher:async()=>({ok:false})};
 assert.deepEqual(await store.privateAccessHealth(options),{configured:true,connected:false});
});

test('legacy approved users are copied once into private storage before authorization switches over',async()=>{
 const S=await import('../lib/security.mjs');const f=fixture();
 process.env.GITHUB_TOKEN='fixture-only';
 const legacy={users:[{id:'123',role:'staff'}],blocked:[{id:'999'}]};
 const fetcher=async(url,options)=>{
  if(url==='https://fixture.upstash.io')return f.options.fetcher(url,options);
  return {ok:true,json:async()=>({content:Buffer.from(JSON.stringify(legacy)).toString('base64')})};
 };
 const options={...f.options,fetcher};
 assert.deepEqual(await S.allowlist(options),legacy);
 assert.deepEqual(await S.allowlist(options),legacy);
 const sets=f.calls.filter(call=>JSON.parse(call.options.body)[0]==='SET');
 assert.equal(sets.length,1);
});
