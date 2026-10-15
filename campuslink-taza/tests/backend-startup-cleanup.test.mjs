import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import express from 'express';
import pg from 'pg';
import {S3Client} from '@aws-sdk/client-s3';
import {createApp} from '../server/app.js';
import {createTestEnvironment} from './backend-helpers.mjs';

const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
let fixture;
before(async()=>{if(process.env.CAMPUS_TEST_DATABASE_URL)fixture=await createTestEnvironment({demo:false});});
after(async()=>{await fixture?.close();});
const fakeStorageConfig={R2_ENDPOINT:'https://storage.example.invalid',R2_ACCESS_KEY_ID:'fixture-key',R2_SECRET_ACCESS_KEY:'fixture-secret',R2_BUCKET_NAME:'uploads',R2_REGION:'auto',CAMPUS_STORAGE_PREFIX:''};
async function withEnvironment(values,callback){
  const previous=new Map(Object.keys(values).map(key=>[key,process.env[key]]));
  try{for(const [key,value]of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}return await callback();}
  finally{for(const [key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
async function withTrackedPools(callback){
  const Pool=pg.Pool,pools=[];
  pg.Pool=class extends Pool{constructor(options){super(options);pools.push(this);}};
  try{return await callback(pools);}
  finally{pg.Pool=Pool;await Promise.all(pools.filter(pool=>!pool.ending).map(pool=>pool.end()));}
}
const ownedDatabase=()=>({connectionString:process.env.CAMPUS_TEST_DATABASE_URL,schema:fixture.schema,migrate:false,seed:false});
function failingPermissions(error){
  return {...fixture.db,prepare(sql){const statement=fixture.db.prepare(sql);return sql==='SELECT user_id FROM platform_owner WHERE singleton=TRUE'?{...statement,async get(){throw error;}}:statement;}};
}

integration('failed storage initialization closes its owned database and leaves supplied auth open',async()=>{
  let authClosed=0;
  await withTrackedPools(async pools=>withEnvironment({R2_ENDPOINT:undefined},async()=>{
    await assert.rejects(()=>createApp({...ownedDatabase(),auth:{close(){authClosed++;}}}),/Missing server configuration:.*R2_ENDPOINT/);
    assert.equal(pools.length,1);assert.equal(pools[0].ended,true,'A failed startup cannot retain its PostgreSQL pool.');
    assert.equal(authClosed,0,'Supplied resources remain owned by the caller on failure.');
  }));
});

integration('failed auth initialization closes both its owned storage and its owned database',async()=>{
  const destroy=S3Client.prototype.destroy;let storageClosed=0;
  S3Client.prototype.destroy=function(){storageClosed++;return destroy.call(this);};
  try{await withTrackedPools(async pools=>withEnvironment({...fakeStorageConfig,NEON_AUTH_BASE_URL:undefined},async()=>{
    await assert.rejects(()=>createApp(ownedDatabase()),error=>error.code==='AUTH_CONFIGURATION');
    assert.equal(pools.length,1);assert.equal(pools[0].ended,true);assert.equal(storageClosed,1);
  }));}finally{S3Client.prototype.destroy=destroy;}
});

integration('failed permissions initialization leaves all supplied resources open',async()=>{
  const original=new Error('Controlled permissions initialization failure.');let closed=0;
  const db={...failingPermissions(original),close(){closed++;}};
  await assert.rejects(()=>createApp({db,storage:{close(){closed++;}},auth:{close(){closed++;}},seed:false}),error=>error===original);
  assert.equal(closed,0,'Failure cleanup must not close caller-owned dependencies.');
});

integration('cleanup failures preserve the original permissions initialization error',async()=>{
  const original=new Error('Controlled permissions initialization failure.'),destroy=S3Client.prototype.destroy;let storageClosed=0;
  S3Client.prototype.destroy=function(){storageClosed++;destroy.call(this);throw new Error('Controlled storage cleanup failure.');};
  try{await withEnvironment(fakeStorageConfig,async()=>{
    await assert.rejects(()=>createApp({db:failingPermissions(original),auth:{},seed:false}),error=>error===original);
    assert.equal(storageClosed,1);
  });}finally{S3Client.prototype.destroy=destroy;}
});

integration('late route installation failures end allocated streams and retain supplied dependencies',async()=>{
  const original=new Error('Controlled route installation failure.'),post=express.application.post;let streamsEnded=0,closed=0;
  express.application.post=function(path,...handlers){
    if(path==='/api/campus/forum'){
      const endStreams=this.locals.endStreams;
      this.locals.endStreams=()=>{streamsEnded++;endStreams();};
      throw original;
    }
    return post.call(this,path,...handlers);
  };
  try{
    await assert.rejects(()=>createApp({db:{...fixture.db,close(){closed++;}},auth:{close(){closed++;}},storage:{close(){closed++;}},seed:false}),error=>error===original);
    assert.equal(streamsEnded,1);assert.equal(closed,0);
  }finally{express.application.post=post;}
});
