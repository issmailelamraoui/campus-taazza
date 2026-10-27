import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePushNavigation,pendingPushNavigation,clearPushNavigation} from '../src/lib/push-navigation.js';
test('push auth handoff stores only a positive notification ID and expires',()=>{
 const values=new Map();globalThis.sessionStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 capturePushNavigation({pathname:'/app/notifications',search:'?push=42&url=https://evil.test'});assert.equal(pendingPushNavigation(),'42');
 clearPushNavigation();for(const id of ['-1','0','https://evil.test','1e3','9007199254740993']){capturePushNavigation({pathname:'/app/notifications',search:'?push='+encodeURIComponent(id)});assert.equal(pendingPushNavigation(),null);}
 capturePushNavigation({pathname:'/login',search:'?push=12'});assert.equal(pendingPushNavigation(),null);
 capturePushNavigation({pathname:'/app/notifications',search:'?push=12'});const key=[...values.keys()][0];values.set(key,JSON.stringify({id:'12',at:Date.now()-31*60*1000}));assert.equal(pendingPushNavigation(),null);
 delete globalThis.sessionStorage;
});
