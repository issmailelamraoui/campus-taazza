import {randomUUID} from 'node:crypto';

// A small shared invalidation journal also works with transaction poolers and
// separate serverless instances; an in-process subscriber map alone does not.
export async function createRealtimeBus({db,active,deliver}) {
 const origin=randomUUID();
 let cursor=Number((await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM realtime_events').get()).id),closed=false,running=false,ticks=0;
 async function publish(event){
  // One statement holds the advisory lock through its implicit commit, avoiding
  // four cloud round trips for every invalidation.
  await db.prepare(`WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtext(?)))
   INSERT INTO realtime_events(origin,faculty_id,filiere_id,user_ids,change)
   SELECT ?,?,?,?::jsonb,?::jsonb FROM locked`).run('campuslink:realtime:'+db.schema,origin,event.faculty||null,event.filiereId||null,event.ids?JSON.stringify(event.ids):null,JSON.stringify(event.change||{}));
 }
 const timer=setInterval(async()=>{
  if(closed||running||!active())return;
  running=true;
  try{
   const events=await db.prepare('SELECT * FROM realtime_events WHERE id>? ORDER BY id LIMIT 500').all(cursor);
   for(const event of events){
    if(event.origin!==origin)await deliver({faculty:event.faculty_id,filiereId:event.filiere_id,ids:event.user_ids,change:event.change});
    cursor=Number(event.id);
   }
   if(++ticks%120===0){await db.prepare("DELETE FROM realtime_events WHERE created_at<CURRENT_TIMESTAMP-INTERVAL '1 hour'").run();await db.prepare("DELETE FROM chat_presence WHERE expires_at<CURRENT_TIMESTAMP-INTERVAL '5 minutes'").run();}
  }catch(error){appError(error);}finally{running=false;}
 },250);
 timer.unref?.();
 function appError(error){if(!closed)console.warn('Realtime synchronization temporarily unavailable:',error.code||'database');}
 return {publish,close(){closed=true;clearInterval(timer);}};
}
