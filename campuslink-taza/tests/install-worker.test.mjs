import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function workerFixture(){
 const origin='https://campus.test',records=new Map(),listeners={};
 const path=request=>new URL(typeof request==='string'?request:request.url,origin).pathname;
 const cache={
  async match(request){return records.get(path(request))?.clone();},
  async put(request,response){records.set(path(request),response);},
  async delete(request){return records.delete(path(request));},
  async keys(){return [...records.keys()].map(value=>new Request(origin+value));},
  async addAll(paths){for(const value of paths)records.set(value,new Response(value==='/index.html'?'<script src="/assets/index-fixture.js"></script><link href="/assets/index-fixture.css">':'fixture'));},
 };
 const context=vm.createContext({URL,Set,Promise,Request,Response,self:{location:{origin},addEventListener:(name,listener)=>listeners[name]=listener,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>[],delete:async()=>true},fetch:async()=>new Response('fixture')});
 vm.runInContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),context);
 let installed;listeners.install({waitUntil:promise=>installed=promise});await installed;
 return {records,async fetchAsset(value){let response;listeners.fetch({request:{url:origin+value,method:'GET',mode:'cors'},respondWith:promise=>response=promise});return response;},async message(paths){let completion,reply;listeners.message({data:{type:'CACHE_PUBLIC_ASSETS',paths},ports:[{postMessage:value=>reply=value}],waitUntil:promise=>completion=promise});await completion;return reply;}};
}

test('browsing many routes preserves application entry assets and a bounded public cache',async()=>{
 const worker=await workerFixture();
 for(let index=0;index<85;index++)assert.equal((await worker.fetchAsset(`/assets/route-${index}.js`)).status,200);
 assert.ok(worker.records.has('/assets/index-fixture.js'));assert.ok(worker.records.has('/assets/index-fixture.css'));
 assert.equal([...worker.records.keys()].filter(path=>path.startsWith('/assets/')).length,80);
});
test('explicit reader caching includes recent assets and rejects private paths',async()=>{
 const worker=await workerFixture(),paths=Array.from({length:80},(_,index)=>`/assets/route-${index}.js`);
 const reply=await worker.message([...paths,'/api/private','https://external.test/assets/remote.js']);
 assert.equal(reply.ok,true);assert.ok(worker.records.has('/assets/route-79.js'));assert.equal(worker.records.has('/api/private'),false);
 assert.ok(worker.records.has('/assets/index-fixture.js'));
});
