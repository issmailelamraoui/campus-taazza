import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { openDatabase } from '../server/db.js';

test('an idle pool error cannot crash the API or expose connection credentials', async () => {
  const originalPool=pg.Pool,originalError=console.error,logs=[];
  let pool,db;
  class FixturePool extends EventEmitter {
    constructor(){super();pool=this;}
    async query(sql){return {rows:sql.includes('AS alive')?[{alive:1}]:[],rowCount:0};}
    async end(){this.closed=true;}
  }
  pg.Pool=FixturePool;
  console.error=(...parts)=>logs.push(parts.join(' '));
  try {
    db=await openDatabase({connectionString:'postgres://fixture.invalid/test',migrate:false});
    assert.doesNotThrow(()=>pool.emit('error',new Error('Simulated disconnect with private connection details.')));
    assert.equal(logs.length,1);
    assert.ok(!logs[0].includes('private connection details'));
    assert.equal((await db.prepare('SELECT 1 AS alive').get()).alive,1,'The application can continue making database requests.');
  } finally {
    await db?.close();pg.Pool=originalPool;console.error=originalError;
  }
  assert.equal(pool.closed,true);
});
