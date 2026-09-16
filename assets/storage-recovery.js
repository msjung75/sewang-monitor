/* Non-destructive upgrade of browser records. Never upload device records. */
(function(root, factory){
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.SewangRecovery=api;
})(typeof globalThis!=='undefined'?globalThis:this, function(){
  'use strict';
  const roles=['admin','staff','sales','viewer'];
  const keys=['sewang-v12','sewang_customers','sewang_customer_stores','sewang_store_wholesaler_v1','sewang_visits'];
  const claimKey='sewang-legacy-claim-v18';
  const object=x=>x && typeof x==='object' && !Array.isArray(x)?x:{};
  const array=x=>Array.isArray(x)?x:[];
  function read(storage,key){const raw=storage.getItem(key);return raw?JSON.parse(raw):null;}
  function scope(user,key){return 'sewang-account-v18:'+user.id+':'+key;}
  function union(old,current,identity){
    const found=new Map();
    [...array(old),...array(current)].forEach(x=>{if(x==null)return;const id=identity(x);if(id)found.set(id,x);});
    return [...found.values()];
  }
  const storeId=x=>x.id || (x.name?x.name+'|'+(x.addr||''):'');
  function inspect(storage,user){
    if(!user || user.id==null || !roles.includes(user.role))return {status:'unavailable'};
    try{
      const claimed=read(storage,claimKey);
      if(claimed && String(claimed.id)!==String(user.id))return {status:'other-account'};
      if(read(storage,scope(user,'legacy-recovery-v1')))return {status:'done'};
      const state=object(read(storage,'sewang-v12')),old=object(read(storage,'sewang-v3'));
      // A known owner must match. Most older builds never recorded an owner;
      // those require the signed-in person to explicitly claim their device records.
      const owners=[state.me,old.me].filter(x=>x && x.id!=null).map(x=>String(x.id));
      if(owners.some(id=>id!==String(user.id)))return {status:'other-account'};
      const tracked=union(old.tracked,state.tracked,storeId);
      const brands=array(object(read(storage,'sewang_customers')).brands);
      const stores=array(object(read(storage,'sewang_customer_stores')).stores);
      const visits=object(read(storage,'sewang_visits'));
      const wholesalers=object(read(storage,'sewang_store_wholesaler_v1'));
      const counts={tracked:tracked.length,brands:brands.length,stores:stores.length,visits:array(visits.visits).length,wholesalers:Object.keys(wholesalers).length};
      return {status:Object.values(counts).some(Boolean)?'available':'empty',counts};
    }catch{return {status:'unreadable'};}
  }
  function restore(storage,user,confirmed){
    const before=inspect(storage,user);
    if(before.status!=='available' || confirmed!==true)return {...before,restored:false};
    const writes=new Map(),previous=new Map();
    try{
      const old=object(read(storage,'sewang-v3'));
      for(const key of keys){
        const legacy=object(read(storage,key)),current=object(read(storage,scope(user,key)));
        let value;
        if(key==='sewang-v12'){
          value={...current,tracked:union(union(old.tracked,legacy.tracked,storeId),current.tracked,storeId),me:user};
          // Derived permit/search caches are reloadable; do not duplicate them
          // into a full browser store at the expense of irreplaceable sales notes.
          value={tracked:value.tracked,me:value.me};
        }else if(key==='sewang_customers')value={...legacy,...current,brands:union(legacy.brands,current.brands,x=>typeof x==='string'?x.replace(/\s/g,'').toLowerCase():'')};
        else if(key==='sewang_customer_stores')value={...legacy,...current,stores:union(legacy.stores,current.stores,x=>x.n?x.n+'|'+(x.r||''):'')};
        else if(key==='sewang_visits'){
          const visits=union(legacy.visits,current.visits,x=>x.ts);
          const oldTimes=new Set(array(legacy.visits).map(x=>x.ts)),newTimes=new Set(array(current.visits).map(x=>x.ts));
          const added=array(current.visits).filter(x=>!oldTimes.has(x.ts)).length,oldOnly=array(legacy.visits).filter(x=>!newTimes.has(x.ts)).length;
          value={...legacy,...current,visits,total_count:Math.max((Number(legacy.total_count)||0)+added,(Number(current.total_count)||0)+oldOnly,visits.length),first_visit:Math.min(...[legacy.first_visit,current.first_visit].filter(x=>Number(x)>0).map(Number))||Date.now()};
          if(!Number.isFinite(value.first_visit))value.first_visit=Date.now();
        }else value={...legacy,...current};
        if(Object.keys(legacy).length || Object.keys(current).length || key==='sewang-v12')writes.set(scope(user,key),JSON.stringify(value));
      }
      writes.set(scope(user,'legacy-recovery-v1'),JSON.stringify({at:new Date().toISOString(),counts:before.counts}));
      writes.set(claimKey,JSON.stringify({id:String(user.id)}));
      for(const key of writes.keys())previous.set(key,storage.getItem(key));
      for(const [key,value] of writes)storage.setItem(key,value);
      return {status:'done',restored:true,counts:before.counts};
    }catch{
      // No source key is ever removed. Roll back incomplete target writes.
      for(const [key,value] of previous){try{if(value===null)storage.removeItem(key);else storage.setItem(key,value);}catch{}}
      return {status:'save-failed',restored:false};
    }
  }
  return {inspect,restore};
});
