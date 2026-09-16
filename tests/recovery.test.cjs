const {test}=require('node:test');
const assert=require('node:assert/strict');
const R=require('../assets/storage-recovery.js');
const user={id:'123',role:'staff'};
const scoped=k=>'sewang-account-v18:123:'+k;
function storage(seed={}){
  const values=new Map(Object.entries(seed).map(([k,v])=>[k,JSON.stringify(v)]));
  return {getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),values};
}
test('legacy records require a signed-in person to claim their records; sources remain unchanged',()=>{
  const s=storage({'sewang-v12':{tracked:[{id:'a',note:'old memo'}]},sewang_customers:{brands:['가상 브랜드']},sewang_customer_stores:{stores:[{n:'가상매장',r:'서울'}]}});
  const original=new Map(s.values);
  assert.equal(R.inspect(s,user).status,'available');
  assert.equal(R.restore(s,user,false).restored,false);
  assert.equal(s.getItem(scoped('sewang-v12')),null);
  assert.equal(R.restore(s,user,true).restored,true);
  assert.equal(JSON.parse(s.getItem(scoped('sewang-v12'))).tracked[0].note,'old memo');
  for(const [k,v] of original)assert.equal(s.getItem(k),v);
});
test('merge keeps newer edits, recovers v3 records, deduplicates customers and never revives deleted records on reload',()=>{
  const s=storage({'sewang-v3':{tracked:[{id:'v3'}]},'sewang-v12':{tracked:[{id:'a',note:'old'},{id:'b'}]},[scoped('sewang-v12')]:{tracked:[{id:'a',note:'new'}]},sewang_customers:{brands:['Brand A']},[scoped('sewang_customers')]:{brands:['BrandA','BrandB']}});
  assert.equal(R.restore(s,user,true).restored,true);
  const state=JSON.parse(s.getItem(scoped('sewang-v12')));
  assert.equal(state.tracked.length,3);assert.equal(state.tracked.find(x=>x.id==='a').note,'new');
  assert.deepEqual(JSON.parse(s.getItem(scoped('sewang_customers'))).brands,['BrandA','BrandB']);
  s.setItem(scoped('sewang-v12'),JSON.stringify({tracked:[]}));
  assert.equal(R.restore(s,user,true).restored,false);
  assert.equal(JSON.parse(s.getItem(scoped('sewang-v12'))).tracked.length,0);
  assert.equal(R.inspect(s,{...user,id:'456'}).status,'other-account');
});
test('pending, anonymous, owner and known different accounts cannot claim sales records',()=>{
  const s=storage({'sewang-v12':{me:{id:'123'},tracked:[{id:'a'}]}});
  for(const u of [null,{...user,role:'pending'},{...user,role:'owner'},{...user,id:'456'}])assert.equal(R.restore(s,u,true).restored,false);
  assert.equal(s.getItem(scoped('sewang-v12')),null);
});
test('quota error rolls back target writes and retains every legacy record',()=>{
  const s=storage({'sewang-v12':{tracked:[{id:'a'}]},sewang_customers:{brands:['A']},[scoped('sewang-v12')]:{tracked:[{id:'b'}]}});
  const original=new Map(s.values),set=s.setItem;let count=0;
  s.setItem=(k,v)=>{if(++count===2)throw Error('quota');set(k,v);};
  assert.equal(R.restore(s,user,true).status,'save-failed');
  assert.deepEqual(s.values,original);
  assert.equal(R.restore(s,user,true).restored,true);
});
test('damaged JSON is retained for recovery instead of silently migrating an empty record',()=>{
  const s=storage({'sewang-v12':{tracked:[{id:'a'}]}});s.setItem('sewang_customer_stores','broken');
  assert.equal(R.inspect(s,user).status,'unreadable');
  assert.equal(R.restore(s,user,true).restored,false);
  assert.equal(s.getItem('sewang_customer_stores'),'broken');
});
