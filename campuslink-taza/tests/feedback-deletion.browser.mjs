import {chromium,expect as baseExpect} from '@playwright/test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createTestApp} from './backend-helpers.mjs';
const expect=baseExpect.configure({timeout:20000});
const env=await createTestApp(),server=env.app.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});const contexts=[],results=[],errors=[];let active;
await mkdir('test-results/feedback-deletion',{recursive:true});
async function context(width,username){const c=await browser.newContext({viewport:{width,height:844},hasTouch:width<761,reducedMotion:'reduce',serviceWorkers:'block'});contexts.push(c);await c.addInitScript(()=>{localStorage.setItem('campuslink-prototype-v1:language','"fr"');localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');});if(username){const r=await c.request.post(origin+'/api/login',{data:{username,password:username==='admin'?'Admin2026!':'Campus2026!'}});assert.ok(r.ok(),await r.text());}const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));return {c,p};}
async function api(actor,path,data,method=data?'POST':'GET'){const r=await actor.c.request.fetch(origin+'/api'+path,{method,...(data?{data}:{})});const body=await r.json();assert.ok(r.ok(),`${path} ${r.status()} ${JSON.stringify(body)}`);return body;}
async function fits(p){assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');}
async function ticket(student,admin,filename){const d=await api(student,'/feedback',{title:'Browser delete '+randomUUID(),description:'Temporary conversation to remove after resolution',category:'concern',client_id:randomUUID()});const id=d.ticket.id;await api(admin,`/admin/feedback/${id}/accept`,{});await api(admin,`/admin/feedback/${id}/replies`,{content:'Resolved answer',client_id:randomUUID()});let file;
 if(filename){const r=await student.c.request.post(origin+`/api/feedback/${id}/attachments`,{multipart:{file:{name:filename,mimeType:'text/plain',buffer:Buffer.from('Temporary private file')}}});assert.ok(r.ok(),await r.text());file=await env.db.prepare('SELECT * FROM contact_attachments WHERE contact_id=?').get(id);}
 return {id,file};}
async function scenario(name,run){const detail=await run();results.push({name,...detail});console.log('PASS '+name);}
const student=await context(390,'yassine'),admin=await context(1280,'professeure');
try{
 for(const width of [1280,320])await scenario(`Cancel then permanently delete a ${width===320?'closed phone':'live desktop'} conversation; the student updates without reload`,async()=>{
  await admin.p.setViewportSize({width,height:844});const {id,file}=await ticket(student,admin,'private-'+width+'.txt');
  await student.p.goto(origin+`/app/feedback?ticket=${id}`);await expect(student.p.locator('.feedback-message')).toContainText(['Temporary conversation to remove after resolution','Resolved answer']);await expect(student.p.locator('.feedback-delete-actions')).toHaveCount(0);
  await admin.p.goto(origin+`/app/feedback?ticket=${id}&admin=1`);active=admin.p;await expect(admin.p.locator('.feedback-delete-actions')).toBeVisible();
  if(width===320){await admin.p.getByRole('button',{name:'Clôturer la conversation',exact:true}).click();await expect(admin.p.getByRole('button',{name:'Supprimer la conversation',exact:true})).toBeVisible();}
  const remove=admin.p.locator('.feedback-delete-actions button');await remove.click();let modal=admin.p.getByRole('dialog');await expect(modal).toContainText('Elle ne peut pas être annulée.');await fits(admin.p);await admin.p.screenshot({path:`test-results/feedback-deletion/confirm-${width}.png`});
  await modal.getByRole('button',{name:'Annuler',exact:true}).click();await expect(modal).toHaveCount(0);assert.ok(await env.db.prepare('SELECT id FROM contacts WHERE id=?').get(id));assert.ok(env.storage.objects.has(file.object_key));
  await remove.click();modal=admin.p.getByRole('dialog');const response=admin.p.waitForResponse(r=>new URL(r.url()).pathname===`/api/admin/feedback/${id}`&&r.request().method()==='DELETE');await modal.getByRole('button',{name:'Supprimer définitivement',exact:true}).click();assert.equal((await response).status(),200);await expect(admin.p).toHaveURL(/\/app\/admin\?tab=assistance/);
  await expect(student.p.locator('.feedback-removed')).toBeVisible();await expect(student.p.locator('.feedback-message')).toHaveCount(0);assert.equal(await env.db.prepare('SELECT id FROM contacts WHERE id=?').get(id),undefined);assert.equal(env.storage.objects.has(file.object_key),false);
  await student.p.reload();await expect(student.p.locator('.feedback-removed')).toBeVisible();await student.p.getByRole('button',{name:'Mes demandes',exact:true}).click();await expect(student.p.locator('.feedback-ticket').filter({hasText:'#'+id})).toHaveCount(0);await fits(student.p);
 });
 await scenario('A storage failure keeps the error visible and the closed session can be deleted on retry',async()=>{
  await admin.p.setViewportSize({width:390,height:844});const {id,file}=await ticket(student,admin,'retry.txt');await admin.p.goto(origin+`/app/feedback?ticket=${id}&admin=1`);active=admin.p;await admin.p.locator('.feedback-delete-actions button').click();env.storage.failNextDelete=true;
  let modal=admin.p.getByRole('dialog');await modal.getByRole('button',{name:'Supprimer définitivement',exact:true}).click();await expect(modal.getByRole('alert')).toContainText('réessayez');await expect(modal.getByRole('button',{name:'Supprimer définitivement',exact:true})).toBeEnabled();assert.ok(env.storage.objects.has(file.object_key));assert.equal((await env.db.prepare('SELECT status FROM contacts WHERE id=?').get(id)).status,'closed');
  await admin.p.screenshot({path:'test-results/feedback-deletion/retry-390.png'});await fits(admin.p);await modal.getByRole('button',{name:'Supprimer définitivement',exact:true}).click();await expect(admin.p).toHaveURL(/\/app\/admin\?tab=assistance/);assert.equal(await env.db.prepare('SELECT id FROM contacts WHERE id=?').get(id),undefined);
 });
 await scenario('Deleting a public support session removes its guest messages and returns the guest to a clean request form',async()=>{
  const guest=await context(390),key=randomBytes(32).toString('hex');const body=await api(guest,'/support/request',{name:'Guest browser cleanup',email:'guest-cleanup@example.test',faculty_id:'flaa',subject:'Resolved public access request',message:'Private initial question',recovery_key:key});const id=body.ticket.id;await api(admin,`/admin/feedback/${id}/accept`,{});await api(guest,'/support/replies',{content:'Private guest message',client_id:randomUUID()});
  await guest.p.goto(origin+'/support');await expect(guest.p.getByRole('heading',{name:new RegExp('#'+id)})).toBeVisible();await guest.p.getByLabel('Votre message',{exact:true}).fill('Unsent private draft');
  await admin.p.goto(origin+`/app/feedback?ticket=${id}&admin=1`);active=admin.p;await admin.p.locator('.feedback-delete-actions button').click();await admin.p.getByRole('dialog').getByRole('button',{name:'Supprimer définitivement',exact:true}).click();await expect(admin.p).toHaveURL(/\/app\/admin\?tab=assistance/);
  await expect(guest.p.getByRole('heading',{name:new RegExp('#'+id)})).toHaveCount(0);await expect(guest.p.getByRole('button',{name:'Envoyer ma demande',exact:true})).toBeVisible();assert.equal((await guest.c.request.get(origin+'/api/support/session')).status(),401);assert.equal(Number((await env.db.prepare('SELECT COUNT(*) AS n FROM contact_replies WHERE contact_id=?').get(id)).n),0);await fits(guest.p);
 });
 assert.deepEqual(errors,[]);await writeFile('test-results/feedback-deletion/results.json',JSON.stringify({results,errors},null,2));console.log(`PASS ${results.length} real API browser scenarios`);
}catch(error){console.error(error);await active?.screenshot({path:'test-results/feedback-deletion/failure.png'}).catch(()=>{});await writeFile('test-results/feedback-deletion/results.json',JSON.stringify({results,errors,failure:String(error)},null,2));process.exitCode=1;}
finally{for(const c of contexts)await c.close();await browser.close();env.app.locals.endStreams();await new Promise(r=>server.close(r));await env.close();}
