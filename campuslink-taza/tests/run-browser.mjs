import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createApp} from '../server/app.js';
const directory=await mkdtemp(join(tmpdir(),'campuslink-browser-'));
const app=createApp({dataDir:directory,appOrigin:'http://localhost:5174'});
const server=app.listen(5174,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const origin='http://localhost:5174';
const env={...process.env,CAMPUS_BROWSER_ORIGIN:origin,CAMPUS_BROWSER_URL:origin};
async function waitReady(){for(let i=0;i<80;i++){try{if((await fetch(origin+'/api/health')).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('Browser test server did not start.');}
try{await waitReady();const suites=(process.env.CAMPUS_BROWSER_SUITES||'community,study,admin').split(',');for(const suite of suites){if(!['community','study','admin'].includes(suite))throw new Error('Unknown browser suite.');console.log(`\nRunning ${suite} browser suite in isolated data.`);const child=spawn(process.execPath,[`tests/${suite}.browser.mjs`],{env,stdio:'inherit'});const code=await new Promise(resolve=>child.once('exit',resolve));if(code!==0)throw new Error(`${suite} browser suite failed (${code}).`);}console.log('\nAll selected browser suites passed.');}
finally{app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));app.locals.close();await rm(directory,{recursive:true,force:true});}
