import test from 'node:test';
import assert from 'node:assert/strict';
import {chatRequest,clientPath,isAdministrator,normalizeBootstrap,normalizeMessage,normalizeResource,normalizeUser} from '../src/lib/backend.js';

const resource={id:42,title:'Algorithmes',filename:'cours.pdf',faculty_id:'fsa',filiere_id:'data_science',semester:5,module:'Algorithmique',category:'exercises',resource_type:'tp',part_number:'12345678901234567890',teacher_name:'Pr. A',size:1468006,created_at:'2026-10-09T10:00:00Z',relative_path:'S5/chapitres/cours.pdf',library_visible:true,author:{id:7,name:'Sara'}};
test('real backend resource DTO preserves classification, original path and private file URLs',()=>{
 const file=normalizeResource(resource);
 assert.equal(file.id,'42');assert.equal(file.category,'tp');assert.equal(file.part,'12345678901234567890');assert.equal(file.author,'Pr. A');assert.equal(file.uploader,'Sara');
 assert.equal(file.path,'S5/chapitres/cours.pdf');assert.equal(file.url,'/api/files/42');assert.equal(file.downloadUrl,'/api/files/42?download=1');assert.equal(file.sample,false);assert.equal(file.localOnly,false);
 assert.equal(normalizeResource({...resource,part_number:'complete'}).part,'complete');
});
test('all actual administrative roles are recognized without elevating students',()=>{
 for(const role of ['global_admin','faculty_admin','moderator'])assert.ok(isAdministrator(normalizeUser({id:3,role,faculty_id:'flaa',current_semester:2})));
 assert.equal(isAdministrator({role:'student'}),false);assert.equal(isAdministrator(null),false);
});
test('paired study-year chats and replies round-trip through the API contract',()=>{
 for(const semester of [1,3,5])assert.deepEqual(chatRequest(`year-${semester}`),{channel:'filiere',semester});
 const message=normalizeMessage({id:90,faculty_id:'fsa',filiere_id:'data_science',channel:'filiere',semester:6,content:'Voici le cours',reply_to:87,author:{id:7,name:'Sara',username:'sara',avatar:'/api/avatars/7'},attachments:[resource],reactions:{like:2,heart:1},my_reactions:['heart']});
 const legacy=normalizeMessage({id:91,channel:'general',resource_id:42,author:{id:7,name:'Sara'}},[normalizeResource(resource)]);assert.equal(legacy.attachments.length,1);assert.equal(legacy.attachment,null);assert.equal(message.channel,'year-5');assert.equal(message.replyTo,'87');assert.equal(message.authorId,'7');assert.equal(message.attachments[0].id,'42');assert.equal(message.reactions.like,2);assert.deepEqual(message.myReactions,['heart']);
});
test('saved items, history and notification destinations survive backend normalization',()=>{
 const data=normalizeBootstrap({user:{id:7,faculty_id:'fsa',filiere_id:'data_science',role:'student',current_semester:5,account_status:'approved'},resources:[resource],saved:[{type:'resource',id:42},{type:'message',id:90}],history:[{resource_id:42}],notifications:[{id:8,type:'important',read:false,created_at:'2026-10-09T10:00:00Z',path:'/app/chat/filiere?semester=6#message-90'},{id:9,type:'calendar',read:true,path:'/app/calendar#event-3'}]});
 assert.deepEqual(data.saved.map(({type,id})=>({type,id})),[{type:'document',id:'42'},{type:'discussion',id:'90'}]);assert.deepEqual(data.history,['42']);
 assert.equal(data.notifications[0].href,'/app/community?channel=year-5&message=90');assert.equal(data.notifications[0].targetId,'90');assert.equal(data.notifications.length,1);assert.deepEqual(data.events,[]);assert.equal(clientPath('/app/calendar#event-3'),'/app/announcements');
 assert.equal(clientPath('/app/admin?tab=contacts'),'/app/admin?tab=assistance');
});
test('retired community channels and their linked announcements stay hidden for every role',()=>{
 for(const role of ['student','moderator','faculty_admin','global_admin']){
  const data=normalizeBootstrap({user:{id:1,role},channels:[{id:'general'},{id:'help'},{id:'life'}],messages:[{id:1,channel:'general'},{id:2,channel:'help'},{id:3,channel:'life'}],announcements:[{id:4,channel:'important'},{id:5,channel:'life'},{id:6,channel:'important',message_id:2}]});
  assert.deepEqual(data.channels.map(item=>item.id),['general']);assert.deepEqual(data.messages.map(item=>item.id),['1']);assert.deepEqual(data.announcements.map(item=>item.id),['4']);
 }
});
