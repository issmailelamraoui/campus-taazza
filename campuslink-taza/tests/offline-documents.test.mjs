import test from 'node:test';
import assert from 'node:assert/strict';
import {saveOfflineDocument,clearOfflineDocuments} from '../src/lib/offline-documents.js';

test('logout while preparing reader assets cancels an offline download before credentials are used',async()=>{
 const originals=new Map(['navigator','performance','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 let ready,downloads=0;
 try{
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{serviceWorker:{ready:new Promise(resolve=>ready=resolve)}}});
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{getEntriesByType:()=>[{name:'https://campus.test/assets/reader-fixture.js'}]}});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>{downloads++;throw new Error('The previous account must not issue a download.');}});
  const saving=saveOfflineDocument('previous-account',{document:{id:42,version:1,url:'/api/files/42'}});
  await clearOfflineDocuments();ready({active:null});
  await assert.rejects(saving,/session a changé/);assert.equal(downloads,0);
 }finally{for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});
