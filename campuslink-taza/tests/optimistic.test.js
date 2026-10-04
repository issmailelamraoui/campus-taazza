import test from 'node:test';
import assert from 'node:assert/strict';
import { OptimisticState, pendingMessage, putMessage, removeMessage, setPinned, setSaved, setReaction, readNotifications, updateMessage } from '../src/optimistic.js';

const message={id:10,client_id:'client-a',author:{id:2,name:'Issmail'},content:'Bonjour',channel:'general',created_at:'2026-10-03T12:00:00Z',reactions:{like:2},my_reactions:[],pinned:false};
const snapshot=()=>({user:{id:2},messages:[structuredClone(message)],resources:[],announcements:[],saved:[],notifications:[]});

test('pending actions survive refreshes and independent failures only remove their own change',()=>{
  let visible;
  const store=new OptimisticState(next=>visible=next);
  store.replace(snapshot());
  store.put('save',data=>setSaved(data,'message',10,true));
  store.put('reaction',data=>setReaction(data,10,'heart',true));
  const newer=snapshot();newer.messages[0].reactions.like=4;
  store.replace(newer);
  assert.equal(visible.messages[0].reactions.like,4);
  assert.equal(visible.messages[0].reactions.heart,1);
  assert.equal(visible.saved.length,1);
  store.remove('reaction');
  assert.equal(visible.messages[0].reactions.heart,undefined);
  assert.equal(visible.saved.length,1);
  store.confirm('save',data=>setSaved(data,'message',10,true));
  assert.equal(store.operations.size,0);
  assert.equal(visible.saved.length,1);
});

test('server acknowledgements reconcile pending sends by author and client ID without duplicates',()=>{
  const data=snapshot(),draft={...message,id:'pending-client-a',_status:'pending'};
  assert.equal(pendingMessage(data,draft).messages.length,1);
  const otherAuthor={...message,id:11,author:{id:3}};
  const sameKey=putMessage(data,otherAuthor);
  assert.equal(sameKey.messages.length,2);
  const empty={...data,messages:[otherAuthor]};
  const pending=pendingMessage(empty,draft);
  assert.equal(pending.messages.length,2);
  const acknowledged=putMessage(pending,message);
  assert.equal(acknowledged.messages.length,2);
  assert.ok(acknowledged.messages.every(m=>!m._status));
  assert.equal(pendingMessage({...empty,user:{id:2,chat_blocked:true}},draft).messages.length,1);
});

test('a failed send remains retryable and an acknowledgement received through a refresh wins',()=>{
  let visible;const store=new OptimisticState(next=>visible=next);
  store.replace({...snapshot(),messages:[]});
  const draft={...message,id:'pending-client-a',_status:'pending'};
  store.put('send',data=>pendingMessage(data,draft));
  store.put('send',data=>pendingMessage(data,{...draft,_status:'failed'}));
  assert.equal(visible.messages[0]._status,'failed');
  store.replace(snapshot());
  assert.equal(visible.messages.length,1);
  assert.equal(visible.messages[0].id,10);
  store.remove('send');
  assert.equal(visible.messages.length,1);
});

test('pin reconciles the real announcement and deletion removes linked items while keeping files',()=>{
  const data=snapshot();
  data.messages.push({...message,id:12,reply_to:10});
  data.resources=[{id:4,message_id:10,title:'Cours conservé'}];
  const pending=setPinned(data,message,true);
  assert.equal(pending.messages[0].pinned,true);
  assert.equal(pending.announcements[0]._status,'pending');
  const announcement={id:24,message_id:10,content:message.content};
  const committed=setPinned(pending,message,true,announcement);
  assert.equal(committed.announcements.length,1);
  assert.equal(committed.announcements[0].id,24);
  committed.saved=[{type:'message',id:10},{type:'announcement',id:24},{type:'resource',id:4}];
  committed.notifications=[{id:1,path:'/app/chat/general#message-10'},{id:2,path:'/app/announcements#announcement-24'},{id:3,path:'/app/chat/general#message-100'}];
  const deleted=removeMessage(committed,10);
  assert.equal(deleted.messages.length,1);
  assert.equal(deleted.messages[0].reply_to,null);
  assert.deepEqual(deleted.saved,[{type:'resource',id:4}]);
  assert.equal(deleted.resources[0].message_id,null);
  assert.equal(deleted.resources[0].title,'Cours conservé');
  assert.deepEqual(deleted.notifications.map(n=>n.id),[3]);
});

test('absolute optimistic reaction values stay stable through an updated server snapshot',()=>{
  const active=setReaction(snapshot(),10,'like',true);
  assert.equal(active.messages[0].reactions.like,3);
  const refreshed=setReaction(active,10,'like',true);
  assert.equal(refreshed.messages[0].reactions.like,3);
  const removed=setReaction(refreshed,10,'like',false);
  assert.equal(removed.messages[0].reactions.like,2);
});

test('read notifications and account reset leave no pending state behind',()=>{
  const data=snapshot();data.notifications=[{id:1,read:0},{id:2,read:0}];
  assert.deepEqual(readNotifications(data,[1]).notifications.map(n=>n.read),[1,0]);
  assert.deepEqual(readNotifications(data).notifications.map(n=>n.read),[1,1]);
  let visible;const store=new OptimisticState(next=>visible=next);store.replace(data);
  store.put('save',base=>setSaved(base,'message',10,true));store.reset();
  assert.equal(visible,null);assert.equal(store.operations.size,0);
});

test('late acknowledgements do not restore blocked, moved or deleted chat targets',()=>{
  const blocked={...snapshot(),user:{id:2,chat_blocked:true},messages:[]};
  assert.equal(putMessage(blocked,message).messages.length,0);
  for(const account_status of ['pending','rejected','deleted']){
    assert.equal(putMessage({...blocked,user:{id:2,account_status}},message).messages.length,0);
  }
  const moved={...snapshot(),user:{id:2,faculty_id:'feg'},messages:[]};
  assert.equal(putMessage(moved,{...message,faculty_id:'fsa'}).messages.length,0);
  const deleted=removeMessage(snapshot(),10);
  assert.equal(setPinned(deleted,message,true).announcements.length,0);
  assert.equal(setSaved(deleted,'message',10,true).saved.length,0);
  const reactionResult={...message,reactions:{like:3},my_reactions:['like']};
  const commit=data=>updateMessage(data,10,current=>({...current,reactions:reactionResult.reactions,my_reactions:reactionResult.my_reactions}));
  assert.equal(commit(deleted).messages.length,0);
  const pinned=setPinned(snapshot(),message,true);
  assert.equal(commit(pinned).messages[0].pinned,true);
});
