import {spawn} from 'node:child_process';
import {createTestApp} from './helpers.mjs';
const origin='http://localhost:5174';
const environment=await createTestApp({appOrigin:origin});
const {app}=environment;
let server;
const env={...process.env,CAMPUS_BROWSER_ORIGIN:origin,CAMPUS_BROWSER_URL:origin,CAMPUS_BROWSER_DISPOSABLE:'1'};
async function waitReady(){for(let i=0;i<80;i++){try{if((await fetch(origin+'/api/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('Browser test server did not start.');}
try{
  server=app.listen(5174,'127.0.0.1');
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  await waitReady();
  const suites=(process.env.CAMPUS_BROWSER_SUITES||'filiere,community,study,admin,theme,responsive,optimistic,registration,admin-alerts').split(',');
  for(const suite of suites){
    if(!['filiere','community','study','admin','theme','responsive','optimistic','registration','admin-alerts'].includes(suite))throw new Error('Unknown browser suite.');
    console.log(`\nRunning ${suite} browser suite in a disposable PostgreSQL schema.`);
    const child=spawn(process.execPath,[`tests/${suite}.browser.mjs`],{env,stdio:'inherit'});
    const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    if(code!==0)throw new Error(`${suite} browser suite failed (${code}).`);
  }
  console.log('\nAll selected browser suites passed.');
}finally{
  try{
    app.locals.endStreams();
    if(server){await new Promise(resolve=>server.close(resolve));server.closeAllConnections();}
  }finally{await environment.close();}
}
