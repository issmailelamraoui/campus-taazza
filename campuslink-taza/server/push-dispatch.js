import {timingSafeEqual} from 'node:crypto';
import {waitUntil} from '@vercel/functions';
import {afterUploadCommit} from './upload-sessions.js';

export function installPushDispatch(app,{service,secret=process.env.CRON_SECRET,clock=Date.now,retain=waitUntil,afterCommit=afterUploadCommit}) {
  let lastWake=0,active=null,stopped=false;
  function schedule({force,budgetMs}) {
    if(stopped||!service.configured)return;
    if(active){
      // Before the first read of the queue, one drain covers all these wakes.
      // After it starts, a committed publication may arrive after its final
      // empty SELECT: retain one more pass inside the SAME background promise.
      if(force&&active.started)active.dirty=true;
      return;
    }
    if(!force&&clock()-lastWake<15000)return;
    lastWake=clock();
    const budget=Number.isFinite(budgetMs)?Math.max(10,Math.min(40000,budgetMs)):40000;
    const run={started:false,dirty:false,deadline:clock()+budget,promise:null};
    active=run;
    run.promise=Promise.resolve().then(async()=>{
      try{
        // A time budget and a pass cap also bound synchronous/repeated force
        // wakes. Further durable work can be claimed by the next request/cron.
        for(let pass=0;pass<4&&!stopped;pass++){
          const remaining=run.deadline-clock();if(remaining<=0)break;
          run.dirty=false;run.started=true;
          try{await service.dispatch({limit:200,budgetMs:remaining});}
          catch{/* Durable pending jobs are retried on the next wake. */}
          if(!run.dirty)break;
        }
      }finally{
        // Clear synchronously with the final dirty check. A separate .finally
        // microtask would leave another gap in which a wake could be lost.
        if(active===run)active=null;
      }
    });
    if(process.env.VERCEL)retain(run.promise);
  }
  function wake({force=false,budgetMs=40000}={}) {
    if(stopped||!service.configured)return;
    // Pending/throttle decisions happen AFTER the outer upload receipt commits.
    // A wake queued inside a rolled-back publication never marks a live pump.
    return afterCommit(()=>schedule({force,budgetMs}));
  }
  app.get('/api/push/dispatch',async(req,res)=>{
    const received=req.get('authorization')||'',expected=secret?'Bearer '+secret:'';
    if(!expected||Buffer.byteLength(received)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(received),Buffer.from(expected)))return res.status(401).json({error:'Non autorisé.'});
    return res.json(await service.dispatch({limit:200,budgetMs:40000}));
  });
  return {wake,settle:()=>active?.promise||null,stop:()=>{stopped=true;}};
}
