import test from 'node:test';
import assert from 'node:assert/strict';
import {api,invalidateAPISession,subscribeAPIActivity} from '../src/api.js';

test('API requests use same-origin credentials and preserve authorization failures',async()=>{
 const original=globalThis.fetch;globalThis.window=new EventTarget();let expired=0;window.addEventListener('campus-session-expired',()=>expired++);
 try{
  globalThis.fetch=async(_url,options)=>{assert.equal(options.credentials,'same-origin');assert.equal(options.headers['Content-Type'],'application/json');assert.equal(options.body,JSON.stringify({role:'global_admin'}));return Response.json({error:'Accès refusé'},{status:403});};
  await assert.rejects(api('/admin/users',{method:'POST',body:{role:'global_admin'}}),error=>error.status===403&&error.message==='Accès refusé');assert.equal(expired,0);
 }finally{globalThis.fetch=original;delete globalThis.window;}
});
test('late unauthorized response from an old session cannot sign out the new session',async()=>{
 const original=globalThis.fetch;globalThis.window=new EventTarget();let expired=0,resolve;window.addEventListener('campus-session-expired',()=>expired++);
 try{
  globalThis.fetch=()=>new Promise(done=>resolve=done);const stale=api('/bootstrap');invalidateAPISession();resolve(Response.json({error:'Session expirée'},{status:401}));await assert.rejects(stale,error=>error.status===401);assert.equal(expired,0);
  globalThis.fetch=async()=>Response.json({error:'Session expirée'},{status:401});await assert.rejects(api('/bootstrap'),error=>error.status===401);assert.equal(expired,1);
 }finally{globalThis.fetch=original;delete globalThis.window;}
});
test('an HTML fallback does not become a successful empty backend response',async()=>{
 const original=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response('<!doctype html><html></html>',{status:200,headers:{'content-type':'text/html'}});await assert.rejects(api('/bootstrap'),/réponse du serveur est invalide/);}
 finally{globalThis.fetch=original;}
});
test('saving feedback remains active across concurrent writes and clears after failure or cancellation',async()=>{
 const original=globalThis.fetch,states=[],pending=[];
 const unsubscribe=subscribeAPIActivity(state=>states.push(state));
 try{
  globalThis.fetch=(_url,{signal})=>new Promise((resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true});pending.push(resolve);
  });
  const controller=new AbortController(),read=api('/bootstrap'),write=api('/saved',{method:'POST',body:{id:1}}),cancelled=api('/messages',{method:'POST',body:{content:'Hello'},signal:controller.signal});
  const cancelResult=assert.rejects(cancelled,error=>error.code==='TIMEOUT');
  assert.deepEqual(states.at(-1),{reads:1,writes:2});
  pending[1](Response.json({error:'Unavailable'},{status:503}));await assert.rejects(write,error=>error.status===503);
  assert.deepEqual(states.at(-1),{reads:1,writes:1});
  controller.abort();await cancelResult;assert.deepEqual(states.at(-1),{reads:1,writes:0});
  pending[0](Response.json({ok:true}));await read;assert.deepEqual(states.at(-1),{reads:0,writes:0});
 }finally{unsubscribe();globalThis.fetch=original;}
});
