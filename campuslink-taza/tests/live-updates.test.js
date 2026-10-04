import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { RefreshQueue } from '../src/live-updates.js';

async function until(predicate) {
  for(let index=0;index<200;index++){if(predicate())return;await delay(5);}
  throw new Error('Refresh queue did not make progress.');
}
function held() { let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; }

test('continuous signals start a refresh and coalesce into one serial follow-up', async () => {
  const requests=[];let active=0,maximum=0;
  const queue=new RefreshQueue(()=>{
    const request=held();requests.push(request);active++;maximum=Math.max(maximum,active);
    return request.promise.finally(()=>{active--;});
  },10);
  try {
    for(let index=0;index<12;index++){queue.schedule();await delay(5);}
    assert.equal(requests.length,1,'Continuous signals must not keep postponing the first request.');
    assert.equal(maximum,1);
    requests[0].resolve();await until(()=>requests.length===2);
    assert.equal(maximum,1,'The following snapshot waits for the preceding request.');
    requests[1].resolve();await delay(25);
    assert.equal(requests.length,2,'Many signals need only one follow-up snapshot.');
  } finally {queue.cancel();for(const request of requests)request.resolve();}
});

test('a failed request releases the queue so a later signal can recover', async () => {
  let calls=0;
  const queue=new RefreshQueue(()=>{calls++;if(calls===1)throw new Error('Simulated network failure.');},5);
  try {
    queue.schedule();await until(()=>calls===1);await delay(10);
    queue.schedule();await until(()=>calls===2);
  } finally {queue.cancel();}
});

test('account cleanup cancels scheduled work and old completions cannot unlock a new request', async () => {
  const requests=[];
  const queue=new RefreshQueue(()=>{const request=held();requests.push(request);return request.promise;},5);
  try {
    queue.schedule();queue.cancel();await delay(15);
    assert.equal(requests.length,0);
    queue.schedule();await until(()=>requests.length===1);
    queue.schedule();queue.cancel();
    queue.schedule();await until(()=>requests.length===2);
    requests[0].resolve();await delay(10);
    queue.schedule();await delay(15);
    assert.equal(requests.length,2,'The old account completion cannot clear the new in-flight request.');
    requests[1].resolve();await until(()=>requests.length===3);
    requests[2].resolve();
  } finally {queue.cancel();for(const request of requests)request.resolve();}
});
