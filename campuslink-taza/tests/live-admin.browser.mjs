import {chromium,expect as baseExpect} from '@playwright/test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';
import {chooseOption} from './ui.helpers.mjs';
const expect=baseExpect.configure({timeout:20000});
const env=await createTestApp(),server=env.app.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
const results=[],errors=[],contexts=[];let active;
await mkdir('test-results/live-admin',{recursive:true});
async function scenario(name,run){if(process.env.CAMPUS_LIVE_CASE&&!name.includes(process.env.CAMPUS_LIVE_CASE))return;const detail=await run();results.push({name,...detail});console.log('PASS '+name,detail||'');}
async function session(username,width=1280,password='Campus2026!'){
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});contexts.push(context);
 await context.addInitScript(()=>{localStorage.setItem('campuslink-prototype-v1:language','"fr"');localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');});
 const page=await context.newPage();active=page;page.on('pageerror',e=>errors.push(e.message));
 const r=await context.request.post(origin+'/api/login',{data:{username,password}});assert.ok(r.ok(),await r.text());const user=(await r.json()).user;
 await page.goto(origin+'/app/community?channel=general');await expect(page.locator('.community-composer')).toBeVisible();
 return {page,context,user};
}
async function api(actor,path,body,method=body?'POST':'GET'){
 const r=await actor.context.request.fetch(origin+'/api'+path,{method,...(body?{data:body}:{})});const d=await r.json();assert.ok(r.ok(),`${path}: ${r.status()} ${JSON.stringify(d)}`);return d;
}
async function clearReads(actor){const d=await api(actor,'/bootstrap');const scopes=new Map();for(const m of d.messages){const key=m.channel==='filiere'?'filiere:'+ (m.semester%2?m.semester:m.semester-1):m.channel;const old=scopes.get(key);if(!old||m.id>old.id)scopes.set(key,m);}for(const m of scopes.values())await api(actor,'/messages/read',{channel:m.channel,semester:m.semester,through_id:m.id});}
let a,b,owner;
try{
 a=await session('sara',390);b=await session('yassine');
 await clearReads(a);await a.page.goto(origin+'/app/library');await expect(a.page.locator('.library-page')).toBeVisible();
 await scenario('A typed message is optimistic immediately and arrives in another session without reload',async()=>{
  active=a.page;const text='Live actual UI '+randomUUID(),requests=[];a.page.on('request',r=>{if(r.url().includes('/api/live'))requests.push(r.url());});
  const started=Date.now();await b.page.getByRole('textbox',{name:'Votre message',exact:true}).fill(text);await b.page.locator('.community-composer').getByRole('button',{name:/Envoyer le message/}).click();
  await expect(b.page.locator('.community-message').filter({hasText:text})).toBeVisible();const optimisticMs=Date.now()-started;
  await expect(a.page.locator('.discussion-unread-dot:visible')).toHaveCount(1);const receivedMs=Date.now()-started;
  assert.ok(requests.some(url=>url.includes('message_ids=')),'The recipient uses a bounded delta request');
  await a.page.locator('.mobile-bottom-nav a[href="/app/community"]').click();await a.page.getByRole('button',{name:'Chat général',exact:true}).click();
  await expect(a.page.locator('.community-message').filter({hasText:text})).toBeVisible();await expect(a.page.locator('.discussion-unread-dot:visible')).toHaveCount(0);
  return {optimisticMs,receivedMs};
 });
 await scenario('Each unread channel has a dot; viewing a different channel leaves it unread',async()=>{
  await a.page.setViewportSize({width:1280,height:900});await a.page.getByRole('button',{name:'Discussions importantes',exact:true}).click();
  const sent=await api(b,'/messages',{channel:'general',content:'Unread other channel '+randomUUID(),client_id:randomUUID()});
  await expect(a.page.getByRole('button',{name:'Chat général',exact:true}).locator('.community-unread-dot')).toHaveCount(1);
  assert.ok((await api(a,'/live?inbox=1')).discussion_unread_counts.some(c=>c.channel==='general'&&c.count>0));
  await a.page.getByRole('button',{name:'Chat général',exact:true}).click();await expect(a.page.locator('#message-'+sent.message.id)).toBeVisible();
  await expect(a.page.getByRole('button',{name:'Chat général',exact:true}).locator('.community-unread-dot')).toHaveCount(0);
 });
 await scenario('Reply notification opens and highlights the exact message, including repeated clicks',async()=>{
  const mine=(await api(a,'/messages',{channel:'general',content:'Original precise target',client_id:randomUUID()})).message;
  const reply=(await api(b,'/messages',{channel:'general',content:'Precise reply '+randomUUID(),reply_to:mine.id,client_id:randomUUID()})).message;
  await a.page.locator('.notification-button').click();const notice=a.page.locator('.notification-popover .notification-item').filter({hasText:reply.content});await expect(notice).toBeVisible();await notice.locator('.notification-content').click();
  await expect(a.page).toHaveURL(new RegExp('message='+reply.id));await expect(a.page.locator('#message-'+reply.id)).toHaveClass(/highlight/);
  await a.page.locator('.notification-button').click();await a.page.locator('.notification-filter-tabs').getByRole('button',{name:'Lu',exact:true}).click();await a.page.locator('.notification-popover .notification-item').filter({hasText:reply.content}).locator('.notification-content').click();await expect(a.page.locator('#message-'+reply.id)).toHaveClass(/highlight/);
 });
 await scenario('Reconnect fallback recovers a missed message while EventSource is unavailable',async()=>{
  await a.page.goto(origin+'/app/library');await a.context.route('**/api/events/stream',route=>route.abort());await a.page.reload();await expect(a.page.locator('.library-page')).toBeVisible();
  const start=Date.now();await api(b,'/messages',{channel:'general',content:'Fallback '+randomUUID(),client_id:randomUUID()});await expect(a.page.locator('.discussion-unread-dot:visible')).toHaveCount(1,{timeout:14000});await a.context.unroute('**/api/events/stream');return {fallbackMs:Date.now()-start};
 });
 await scenario('Compact conversation header stays usable from 320 to 1920 pixels and in Arabic',async()=>{
  await a.page.goto(origin+'/app/community?channel=general');await expect(a.page.locator('.community-chat-header')).toBeVisible();
  const widths=[320,360,390,600,760,768,820,1024,1100,1280,1440,1920],records=[];
  for(const width of widths){await a.page.setViewportSize({width,height:900});const m=await a.page.evaluate(()=>{
   const head=document.querySelector('.community-chat-header'),heading=head.querySelector('.community-chat-heading'),title=head.querySelector('h2'),tools=head.querySelector('.community-header-tools'),presence=head.querySelector('.chat-presence');const r=el=>{const v=el.getBoundingClientRect();return {x:v.x,right:v.right,y:v.y,bottom:v.bottom,width:v.width,height:v.height};};return {width:innerWidth,overflow:document.documentElement.scrollWidth-innerWidth,header:r(head),heading:r(heading),title:r(title),tools:r(tools),presence:presence?r(presence):null};});
   assert.ok(m.overflow<=1,JSON.stringify(m));assert.ok(m.header.height<=(width<=760?58:72),JSON.stringify(m));assert.ok(m.heading.right<=m.tools.x+1,JSON.stringify(m));assert.ok(m.title.width>=50,JSON.stringify(m));if(m.presence)assert.ok(m.title.right<=m.presence.x+1,JSON.stringify(m));records.push(m);
   if([320,768,1280].includes(width))await a.page.screenshot({path:`test-results/live-admin/header-${width}.png`});
  }
  await a.page.setViewportSize({width:390,height:844});await a.page.evaluate(()=>localStorage.setItem('campuslink-prototype-v1:language','"ar"'));await a.page.reload();await expect(a.page.locator('.community-chat-header')).toBeVisible();assert.ok(await a.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await a.page.screenshot({path:'test-results/live-admin/header-ar-390.png'});return {widths:records};
 });
 await scenario('Owner can delegate all faculties with separate permissions from the actual form',async()=>{
  owner=await session('admin',1280,'Admin2026!');await owner.page.goto(origin+'/app/permissions');await expect(owner.page.locator('.permissions-form')).toBeVisible();
  const saraName=a.user.name;await chooseOption(owner.page.getByRole('combobox',{name:'Compte',exact:true}),String(a.user.id));await chooseOption(owner.page.getByRole('combobox',{name:'Périmètre',exact:true}),'all');
  await owner.page.getByRole('checkbox',{name:'Accepter ou refuser les inscriptions'}).check();await owner.page.getByRole('checkbox',{name:'Traiter les demandes privées'}).check();
  const result=owner.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/appointments'&&r.request().method()==='POST');await owner.page.getByRole('button',{name:'Accorder la nomination',exact:true}).click();assert.equal((await result).status(),201);
  await expect(owner.page.locator('.permissions-appointment').filter({hasText:saraName})).toHaveCount(4);assert.equal((await api(owner,'/admin/appointments')).appointments.filter(ap=>ap.user_id===a.user.id&&!ap.revoked_at).length,4);
  await owner.page.setViewportSize({width:320,height:844});assert.ok(await owner.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await owner.page.screenshot({path:'test-results/live-admin/permissions-320.png'});
 });
 await scenario('Private replies synchronize on phone and PC; the notification focuses the exact answer with owner identity hidden',async()=>{
  const ticket=(await api(b,'/feedback',{title:'Live private help',description:'Isolated private question',category:'concern',client_id:randomUUID()})).ticket;
  await api(owner,'/admin/feedback/'+ticket.id+'/accept',{});
  await b.page.setViewportSize({width:390,height:844});await b.page.goto(origin+'/app/feedback?ticket='+ticket.id);await expect(b.page.locator('.feedback-reply')).toBeVisible();
  await owner.page.setViewportSize({width:1280,height:900});await owner.page.goto(origin+'/app/feedback?ticket='+ticket.id+'&admin=1');await expect(owner.page.locator('.feedback-reply')).toBeVisible();
  const text='Private live answer '+randomUUID(),start=Date.now();await owner.page.getByRole('textbox',{name:'Ajouter une précision',exact:true}).fill(text);await owner.page.locator('.feedback-reply').getByRole('button',{name:'Répondre',exact:true}).click();await expect(b.page.locator('.feedback-message').filter({hasText:text})).toBeVisible();const receivedMs=Date.now()-start;
  const dto=(await api(b,'/feedback/'+ticket.id)).ticket,posted=dto.replies.at(-1);assert.equal(dto.assigned.name,'Administration');assert.equal(posted.author.name,'Administration');assert.equal(posted.author.id,null);
  await b.page.locator('.notification-button').click();await b.page.locator('.notification-popover .notification-item').filter({hasText:text}).locator('.notification-content').click();await expect(b.page).toHaveURL(new RegExp('#reply-'+posted.id+'$'));await expect(b.page.locator('#reply-'+posted.id)).toBeFocused();assert.ok(await b.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));return {receivedMs};
 });
 await scenario('Delegated all-faculty administrator receives a remote admission automatically and opens its exact request',async()=>{
  const delegated=await session('sara',1024);await delegated.page.goto(origin+'/app/admin?tab=accounts');await expect(delegated.page.locator('.admin-page')).toBeVisible();
  const context=await browser.newContext();contexts.push(context);const username='pending'+randomUUID().slice(0,8);const r=await context.request.post(origin+'/api/register',{data:{username,password:'Campus2026!',name:'Pending remote student',email:username+'@example.test',faculty_id:'feg',filiere_id:'economics',current_semester:1}});assert.equal(r.status(),201);const id=(await r.json()).user.id;
  const popup=delegated.page.locator('.admin-notification-popup').filter({hasText:'Pending remote student'});await expect(popup).toBeVisible();await popup.locator('.admin-notification-popup-open').click();await expect(delegated.page).toHaveURL(new RegExp('registration='+id));await expect(delegated.page.locator('#registration-'+id)).toBeVisible();
 });
 await scenario('Cross-faculty content console displays, pins and removes remote messages while remaining responsive',async()=>{
  if(!owner)owner=await session('admin',1280,'Admin2026!');
  await api(owner,'/admin/appointments',{user_id:a.user.id,role:'faculty_admin',faculty_id:'all',capabilities:['content.moderate','resource.manage','announcement.publish','channel.manage']});
  const remote=await env.db.prepare("INSERT INTO messages(faculty_id,channel,content,author_id,created_at) VALUES('feg','general','Isolated remote moderation fixture',?,?) RETURNING *").get(b.user.id,new Date().toISOString());
  const moderator=await session('sara',1024);active=moderator.page;await moderator.page.goto(origin+'/app/admin?tab=community');await chooseOption(moderator.page.getByRole('combobox',{name:'Filtrer par établissement',exact:true}),'feg');
  const row=moderator.page.locator('.admin-community-row').filter({hasText:remote.content});await expect(row).toBeVisible();await expect(row).toContainText('Yassine');
  await row.getByRole('button',{name:'Épingler',exact:true}).click();await expect(row.getByRole('button',{name:'Désépingler',exact:true})).toHaveAttribute('aria-pressed','true');
  await moderator.page.setViewportSize({width:320,height:844});assert.ok(await moderator.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await moderator.page.screenshot({path:'test-results/live-admin/moderation-320.png'});
  await row.getByRole('button',{name:'Retirer',exact:true}).click();await moderator.page.getByRole('dialog').getByRole('button',{name:'Retirer le message',exact:true}).click();await expect(row).toHaveCount(0);
 });
 assert.deepEqual(errors,[]);await writeFile('test-results/live-admin/results'+(process.env.CAMPUS_LIVE_CASE?'-content':'')+'.json',JSON.stringify({results,errors},null,2));console.log(`PASS ${results.length} scenarios`);
}catch(error){console.error(error);await active?.screenshot({path:'test-results/live-admin/failure.png'}).catch(()=>{});await writeFile('test-results/live-admin/results'+(process.env.CAMPUS_LIVE_CASE?'-content':'')+'.json',JSON.stringify({results,errors,failure:String(error)},null,2));process.exitCode=1;}
finally{for(const context of contexts)await context.close();await browser.close();env.app.locals.endStreams();await new Promise(r=>server.close(r));await env.close();}
