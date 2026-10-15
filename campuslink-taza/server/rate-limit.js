// A bounded, process-local fixed window. Reserving before asynchronous work
// prevents concurrent requests from each observing the same unused allowance.
export function createRateLimiter({limit,windowMs,message,maxKeys=10000,clock=Date.now}) {
  const entries=new Map();
  function reject(expires,now) {
    throw Object.assign(new Error(message),{status:429,retryAfter:Math.max(1,Math.ceil((expires-now)/1000))});
  }
  return {
    take(key) {
      const now=clock();
      let entry=entries.get(key);
      if(entry&&entry.expires<=now){entries.delete(key);entry=null;}
      if(!entry){
        // A sweep is needed only when adding a key at capacity; no timer keeps
        // serverless workers alive and active allowances are never evicted.
        if(entries.size>=maxKeys)for(const [stored,value]of entries)if(value.expires<=now)entries.delete(stored);
        if(entries.size>=maxKeys)reject(Math.min(...Array.from(entries.values(),value=>value.expires)),now);
        entry={count:0,expires:now+windowMs};entries.set(key,entry);
      }
      if(entry.count>=limit)reject(entry.expires,now);
      entry.count++;
      let released=false;
      return ()=>{
        if(released)return;released=true;
        if(entries.get(key)!==entry)return;
        if(--entry.count===0)entries.delete(key);
      };
    },
    reset(key){entries.delete(key);},
  };
}
