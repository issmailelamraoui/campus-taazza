import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';

// Delayed, intercepted responses exercise real provider state without remote writes.
const baseURL=process.env.CAMPUSLINK_TEST_URL||'http://127.0.0.1:5180';
const executable='/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser=await chromium.launch({...(existsSync(executable)?{executablePath:executable}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const errors=[];
async function fixture(role='student',faculty='flaa'){
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.addInitScript(()=>{window.EventSource=undefined;localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');localStorage.setItem('campuslink-prototype-v1:language','"fr"');});
 const user={id:2,username:'responsive-fixture',name:'Fixture User',role,faculty_id:faculty,filiere_id:'french_studies',current_semester:1,account_status:'approved',language:'fr'};
 const resource={id:41,title:'Instant bookmark',filename:'instant.pdf',faculty_id:'flaa',filiere_id:'french_studies',size:1000,semester:1,category:'courses',part_number:'complete',created_at:'2026-10-09T10:00:00Z',library_visible:true,module:'Fixture'};
 let announcement={id:51,title:'Editable announcement',content:'Original text',faculty_id:'flaa',author:{name:'Administration'},created_at:'2026-10-09T10:00:00Z',kind:'administration',pinned:false};
 let saved=[],resourcePresent=true,reportResolved=false,holdBootstrap=false,heldMutation;
 let mutationCount=0,bootstrapCount=0;
 const heldSnapshots=[];
 const payload=()=>({user,faculty:{id:faculty,code:'FLAA',name:'Fixture faculty'},resources:resourcePresent?[resource]:[],messages:[],announcements:announcement?[announcement]:[],notifications:[],events:[],saved,history:[],channels:[],members:[]});
 await context.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();
  if(path==='/api/session')return route.fulfill({json:{user}});
  if(path==='/api/admin/registrations')return route.fulfill({json:{requests:[]}});
  if(path==='/api/chat/blocks')return route.fulfill({json:{blocks:[]}});
  if(path==='/api/admin')return route.fulfill({json:{users:[user],resources:resourcePresent?[resource]:[],announcements:announcement?[announcement]:[],reports:reportResolved?[]:[{id:61,faculty_id:'flaa',target_type:'resource',target_id:41,reason:'incorrect',details:'Fixture reported document',status:'open',created_at:'2026-10-09T10:00:00Z',reporter:{name:'Fixture reporter'}}],contacts:[],channels:[]}});
  if(path==='/api/bootstrap'){
   bootstrapCount++;const body=JSON.stringify(payload());
   if(holdBootstrap){heldSnapshots.push(()=>route.fulfill({contentType:'application/json',body}));return;}
   return route.fulfill({contentType:'application/json',body});
  }
  if(path==='/api/saved'||path==='/api/admin/announcements/51'||path==='/api/admin/reports/61/remove-target'){
   mutationCount++;const body=route.request().postDataJSON();
   assert.equal(heldMutation,undefined,'Duplicate mutations must not start while the first request is pending');
   heldMutation=async(success=true)=>{
    heldMutation=undefined;
    if(!success)return route.fulfill({status:503,json:{error:'Fixture database unavailable'}});
    if(path==='/api/admin/reports/61/remove-target'){resourcePresent=false;reportResolved=true;return route.fulfill({json:{ok:true,target_type:'resource',target_id:41}});}
    if(path==='/api/saved'){
     assert.equal(body.type,'resource');assert.equal(Number(body.id),41);
     saved=saved.length?[]:[{type:'resource',id:41}];return route.fulfill({json:{saved:saved.length>0}});
    }
    if(method==='DELETE'){announcement=null;return route.fulfill({json:{ok:true}});}
    assert.equal(method,'PATCH');announcement={...announcement,...body};return route.fulfill({json:{announcement}});
   };return;
  }
  errors.push(`Unexpected API request ${method} ${path}`);
  return route.fulfill({status:500,json:{error:'Unexpected fixture API request'}});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
 return {context,page,holdSnapshots:()=>{holdBootstrap=true;},releaseSnapshots:async()=>{holdBootstrap=false;await Promise.all(heldSnapshots.splice(0).map(fn=>fn().catch(()=>{})));},get mutationCount(){return mutationCount;},get bootstrapCount(){return bootstrapCount;},get hasMutation(){return Boolean(heldMutation);},resolve:async(success=true)=>{assert.ok(heldMutation,'A held mutation is expected');await heldMutation(success);},close:async()=>{if(heldMutation)await heldMutation(false).catch(()=>{});await Promise.all(heldSnapshots.map(fn=>fn().catch(()=>{})));await context.close();}};
}
try{
 const f=await fixture();
 try{
  await f.page.goto(`${baseURL}/app`);
  let button=f.page.locator('#resource-41 .save-btn').first();
  await expect(button).toHaveAttribute('aria-pressed','false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed','true');
  await expect(button).toBeDisabled();await expect(button).toHaveAttribute('aria-busy','true');
  await expect(f.page.locator('.app-write-status')).toBeVisible();
  assert.equal(f.mutationCount,1);
  await button.evaluate(node=>{node.click();node.click();});assert.equal(f.mutationCount,1);
  await f.page.locator('a[href="/app/saved"]').first().click();
  button=f.page.locator('#resource-41 .save-btn');
  await expect(button).toHaveAttribute('aria-pressed','true');await expect(button).toBeDisabled();
  await expect(f.page.locator('#resource-41')).toBeVisible();
  // A fresh snapshot started during a pending save must preserve the overlay.
  const before=f.bootstrapCount;
  await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>f.bootstrapCount).toBeGreaterThan(before);
  await expect(button).toHaveAttribute('aria-pressed','true');
  await f.resolve();await expect(button).toBeEnabled();
  await button.click();await expect.poll(()=>f.hasMutation).toBe(true);
  await expect(f.page.locator('#resource-41')).toHaveCount(0);
  await f.resolve(false);
  await expect(f.page.locator('#resource-41 .save-btn')).toHaveAttribute('aria-pressed','true');
  await expect(f.page.locator('#resource-41 .save-btn')).toBeEnabled();
  assert.equal(f.mutationCount,2);
  console.log('PASS immediate bookmarks, pending snapshot preservation, cross-page visibility, duplicate prevention and failure rollback');
 }finally{await f.close();}
 const admin=await fixture('global_admin');
 try{
  await admin.page.goto(`${baseURL}/app/announcements`);
  await admin.page.getByRole('button',{name:'Modifier l’annonce: Editable announcement',exact:true}).click();
  const modal=admin.page.getByRole('dialog');
  await modal.locator('input:not([type="checkbox"])').fill('Updated announcement');
  await modal.locator('textarea').fill('Updated content');
  admin.holdSnapshots();
  await modal.locator('button[type="submit"]').click();
  await expect(modal.locator('form')).toHaveAttribute('aria-busy','true');
  await expect(modal.locator('button[type="submit"]')).toBeDisabled();
  await expect.poll(()=>admin.hasMutation).toBe(true);
  await admin.resolve();
  await expect(admin.page.getByRole('dialog')).toHaveCount(0);
  await expect(admin.page.locator('#announcement-51 h3')).toHaveText('Updated announcement');
  await expect.poll(()=>admin.bootstrapCount).toBeGreaterThan(1);
  await admin.releaseSnapshots();
  await admin.page.getByRole('button',{name:'Supprimer l’annonce: Updated announcement',exact:true}).click();
  await admin.page.getByRole('dialog').locator('button[type="submit"]').click();
  await expect(admin.page.locator('#announcement-51')).toHaveCount(0);
  await expect.poll(()=>admin.hasMutation).toBe(true);
  await admin.resolve(false);
  await expect(admin.page.locator('#announcement-51')).toBeVisible();
  await expect(admin.page.getByRole('dialog').getByRole('alert')).toContainText('Fixture database unavailable');
  await admin.page.getByRole('dialog').locator('button[type="submit"]').click();
  await expect.poll(()=>admin.hasMutation).toBe(true);
  await admin.resolve();
  await expect(admin.page.getByRole('dialog')).toHaveCount(0);
  await expect(admin.page.locator('#announcement-51')).toHaveCount(0);
  console.log('PASS direct announcement edit/delete, immediate busy feedback, updates before refresh, deletion rollback and retry');
 }finally{await admin.close();}
 const moderation=await fixture('global_admin');
 try{
  await moderation.page.goto(`${baseURL}/app/admin?tab=reports`);
  await moderation.page.locator('.admin-report-row').getByRole('button',{name:'Examiner',exact:true}).click();
  moderation.holdSnapshots();
  const remove=moderation.page.getByRole('dialog').getByRole('button',{name:'Retirer le document et traiter le signalement',exact:true});
  await remove.click();await expect(moderation.page.getByRole('dialog').locator('.modal-footer button').last()).toBeDisabled();
  await expect.poll(()=>moderation.hasMutation).toBe(true);
  await moderation.resolve();
  await expect(moderation.page.getByRole('dialog')).toHaveCount(0);
  await expect(moderation.page.locator('.admin-report-row')).toHaveCount(0);
  await moderation.page.locator('a[href="/app/library"]').first().click();
  await expect(moderation.page.locator('#resource-41')).toHaveCount(0);
  await expect(moderation.page.getByRole('heading',{level:1})).toContainText('Bibliothèque');
  await expect.poll(()=>moderation.bootstrapCount).toBeGreaterThan(1);
  await moderation.releaseSnapshots();
  console.log('PASS reported resource removal immediately updates admin and library while bootstrap is delayed');
 }finally{await moderation.close();}
 for(const [role,faculty,allowed] of [['student','flaa',false],['moderator','flaa',false],['faculty_admin','flaa',true],['faculty_admin','feg',false]]){
  const f=await fixture(role,faculty);
  try{
   await f.page.goto(`${baseURL}/app/announcements`);
   await expect(f.page.locator('#announcement-51')).toBeVisible();
   await expect(f.page.getByRole('button',{name:'Modifier l’annonce: Editable announcement',exact:true})).toHaveCount(allowed?1:0);
   await expect(f.page.getByRole('button',{name:'Supprimer l’annonce: Editable announcement',exact:true})).toHaveCount(allowed?1:0);
  }finally{await f.close();}
 }
 console.log('PASS announcement controls respect student, moderator and faculty scopes');
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
