import assert from 'node:assert/strict';
import test from 'node:test';
import {createRateLimiter} from '../server/rate-limit.js';

const options={limit:2,windowMs:10000,message:'Try later.'};
const limited=error=>error.status===429&&error.retryAfter>0;

test('reservations immediately consume allowance before asynchronous requests complete',()=>{
  const limiter=createRateLimiter(options);
  const refund=limiter.take('client');
  limiter.take('client');
  assert.throws(()=>limiter.take('client'),limited);
  refund();refund();
  limiter.take('client');
  assert.throws(()=>limiter.take('client'),limited,'A refund can be applied only once.');
});

test('outages can release reservations without retaining a failed credential attempt',()=>{
  const limiter=createRateLimiter(options);
  for(let attempt=0;attempt<20;attempt++)limiter.take('client')();
  limiter.take('client');limiter.take('client');
  assert.throws(()=>limiter.take('client'),limited);
});

test('a stale completion cannot alter a new window or a reset allowance',()=>{
  let now=0;
  const limiter=createRateLimiter({...options,clock:()=>now});
  const oldRefund=limiter.take('client');
  now=10000;
  limiter.take('client');limiter.take('client');oldRefund();
  assert.throws(()=>limiter.take('client'),limited);
  limiter.reset('client');
  limiter.take('client');limiter.take('client');oldRefund();
  assert.throws(()=>limiter.take('client'),limited);
});

test('fixed windows expire and expose the remaining wait in seconds',()=>{
  let now=0;
  const limiter=createRateLimiter({...options,clock:()=>now});
  limiter.take('client');limiter.take('client');
  now=8500;
  assert.throws(()=>limiter.take('client'),error=>error.status===429&&error.retryAfter===2);
  now=10000;
  assert.doesNotThrow(()=>limiter.take('client'));
});

test('capacity remains bounded without evicting active clients and reclaims expired keys',()=>{
  let now=0;
  const limiter=createRateLimiter({...options,maxKeys:2,clock:()=>now});
  limiter.take('first');limiter.take('second');
  assert.throws(()=>limiter.take('third'),limited);
  limiter.take('first');
  assert.throws(()=>limiter.take('first'),limited);
  now=10000;
  assert.doesNotThrow(()=>limiter.take('third'));
  assert.doesNotThrow(()=>limiter.take('fourth'));
  assert.throws(()=>limiter.take('fifth'),limited);
});
