import {chromium,expect as playwrightExpect} from '@playwright/test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestApp} from './backend-helpers.mjs';
import {nativePDFUrl} from '../src/lib/document-open.js';

// Real application, disposable metadata, simulated identity and object storage.
// Full Chromium exercises its native PDF viewer instead of the headless shell.
const expect=playwrightExpect.configure({timeout:20000});
const env=await createTestApp(),server=env.app.listen(0,'127.0.0.1');
await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
const headed=process.env.CAMPUS_PDF_HEADED==='1';
const browser=await chromium.launch({channel:'chromium',headless:!headed,args:['--no-sandbox','--disable-dev-shm-usage']});
const contexts=[],results=[],errors=[],out='test-results/responsive-native-pdf';
const resultFile=out+'/'+(process.env.CAMPUS_RESPONSIVE_SCENARIOS?'results-'+process.env.CAMPUS_RESPONSIVE_SCENARIOS.replace(/\W+/g,'-'):headed?'results-headed':'results')+'.json';
await mkdir(out,{recursive:true});
const folderFixture=await mkdtemp(join(tmpdir(),'cl-picker-'));
await writeFile(join(folderFixture,'folder-note.txt'),'Temporary folder selection, never submitted.');
let active;

function pdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(let i=0;i<2;i++){const stream=`BT /F1 20 Tf 48 780 Td (CampusLink isolated PDF page ${i+1}) Tj ET`;objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);}
 let content='%PDF-1.4\n',offsets=[];for(const [i,value]of objects.entries()){offsets.push(Buffer.byteLength(content));content+=`${i+1} 0 obj\n${value}\nendobj\n`;}
 const xref=Buffer.byteLength(content);content+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(content);
}
async function resource(faculty='flaa',filiere='french_studies',text=false){
 const bytes=text?Buffer.from('Isolated text preview remains readable.'):pdf(),key='native-pdf-test/'+randomUUID(),mime=text?'text/plain':'application/pdf';await env.storage.put(key,bytes,mime);
 return env.db.prepare('INSERT INTO resources (faculty_id,title,filename,object_key,sha256,category,semester,module,author_id,created_at,size,mime,library_visible,filiere_id,part_number) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *').get(faculty,text?'Texte isolé':'PDF natif — méthodes et références universitaires',text?'notes.txt':'cours de révision.pdf',key,createHash('sha256').update(bytes).digest('hex'),'courses',1,'Responsive PDF',3,new Date().toISOString(),bytes.length,mime,1,filiere,'complete');
}
async function actor(username,width=390,height=844,theme='dark',offlineSupport=false){
 const context=await browser.newContext({viewport:{width,height},hasTouch:width<=900,serviceWorkers:offlineSupport?'allow':'block',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(theme=>{localStorage.setItem('campuslink-prototype-v1:language','"fr"');localStorage.setItem('campuslink-prototype-v1:theme',JSON.stringify(theme));localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');},theme);
 if(username){const response=await context.request.post(origin+'/api/login',{data:{username,password:username==='admin'?'Admin2026!':'Campus2026!'}});assert.ok(response.ok(),await response.text());}
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return {context,page};
}
async function scenario(name,run){if(process.env.CAMPUS_RESPONSIVE_SCENARIOS&&!new RegExp(process.env.CAMPUS_RESPONSIVE_SCENARIOS).test(name))return;await run();results.push(name);console.log('PASS '+name);}
async function fits(page,label){
 const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
 assert.ok(geometry.scrollWidth<=geometry.width+1,label+': horizontal overflow '+JSON.stringify(geometry));
}
async function modalFits(page,label){
 const modal=page.getByRole('dialog');await expect(modal).toBeVisible();
 const geometry=await modal.evaluate(node=>{
  const r=node.getBoundingClientRect(),body=node.querySelector('.modal-body'),footer=node.querySelector('.modal-footer');
  const rect=x=>{const r=x.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width};};
  return {dialog:rect(node),body:rect(body),bodyFits:body.scrollWidth<=body.clientWidth+1,footer:footer?rect(footer):null,controls:[...node.querySelectorAll('.btn')].filter(x=>x.getClientRects().length).map(x=>({label:x.textContent,...rect(x)}))};
 });
 const {width,height}=page.viewportSize();
 assert.ok(geometry.dialog.left>=-1&&geometry.dialog.right<=width+1&&geometry.dialog.top>=-1&&geometry.dialog.bottom<=height+1,label+': dialog leaves viewport '+JSON.stringify(geometry));
 assert.ok(geometry.bodyFits,label+': body scrolls horizontally');
 for(const button of geometry.controls){assert.ok(button.left>=geometry.dialog.left&&button.right<=geometry.dialog.right+1,label+': action leaves dialog '+button.label);if(width<=900)assert.ok(button.height>=43,label+': touch target too small '+button.label);}
 // Reach the last form control through the scrollable body, without the footer
 // or the phone navigation obscuring its centre.
 const last=modal.locator('.modal-body :is(input:not([type=hidden]),textarea,button,a[href]):visible').last();
 if(await last.count()){
  await last.scrollIntoViewIfNeeded();
  assert.ok(await last.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button,a,input,textarea')===node;}),label+': last body control is covered');
 }
 await fits(page,label);return geometry;
}

try{
 const own=await resource(),foreign=await resource('feg','economics');
 // Password recovery accepts provider-shaped UUIDs. This remains an identity
 // in the injected test double; no provider account is created or contacted.
 const account=await env.db.prepare('SELECT auth_user_id FROM users WHERE id=3').get();
 const identity=env.auth.identities.get(account.auth_user_id),authId=randomUUID();
 env.auth.identities.delete(account.auth_user_id);identity.id=authId;env.auth.identities.set(authId,identity);
 await env.db.prepare('UPDATE users SET auth_user_id=? WHERE id=3').run(authId);
 const admin=await actor('admin'),student=await actor('yassine');active=admin.page;
 const configurations=[{width:320,height:568},{width:390,height:844},{width:768,height:1024},{width:1024,height:768},{width:1440,height:900},{width:1920,height:1080},{width:640,height:360}];
 for(const config of configurations)await scenario(`Account and form actions fit ${config.width}×${config.height}`,async()=>{
  const page=admin.page;active=page;await page.setViewportSize(config);await page.goto(origin+'/app/admin?tab=accounts');
  const review=page.locator('[data-account-id="3"]').getByRole('button',{name:'Consulter Yassine',exact:true});await review.click();
  const modal=page.getByRole('dialog');await expect(modal.locator('.modal-footer .btn')).toHaveCount(2);
  const footer=await modal.locator('.modal-footer').boundingBox();assert.ok(footer.height<90,'Account footer remains one compact row');
  await modal.locator('.admin-account-tools summary').click();await expect(modal.locator('.admin-account-secondary-actions .btn')).toHaveCount(3);
  const geometry=await modalFits(page,'account '+config.width);await page.screenshot({path:`${out}/account-${config.width}-${config.height}.png`});
  // Every previously crowded action still goes to its intended operation.
  if([320,1440].includes(config.width)){
   await modal.getByRole('button',{name:'Réinitialiser le mot de passe',exact:true}).click();await expect(page.locator('.admin-password-reset')).toBeVisible();await modalFits(page,'reset '+config.width);await page.keyboard.press('Escape');
   await review.click();await page.getByRole('dialog').getByRole('button',{name:'Modifier',exact:true}).click();await expect(page.locator('#admin-account-form')).toBeVisible();await modalFits(page,'edit '+config.width);await page.keyboard.press('Escape');
   await review.click();await page.getByRole('dialog').locator('summary').click();await page.getByRole('dialog').getByRole('button',{name:'Nommer administrateur de sa faculté',exact:true}).click();await expect(page).toHaveURL(/\/app\/permissions\?user=3$/);await expect(page.locator('.permissions-page')).toBeVisible();await page.goBack();
   await review.click();await page.getByRole('dialog').locator('summary').click();await page.getByRole('dialog').getByRole('button',{name:'Supprimer le compte',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Supprimer');await modalFits(page,'delete '+config.width);await page.keyboard.press('Escape');
   assert.ok(await env.db.prepare('SELECT id FROM users WHERE id=3').get(),'Cancelling does not delete the account');
  }else await page.keyboard.press('Escape');
  // Long creation forms remain fully scrollable and their submit/cancel controls
  // stay accessible without making changes to any account.
  await page.getByRole('button',{name:'Ajouter un compte',exact:true}).click();await modalFits(page,'create '+config.width);await page.keyboard.press('Escape');
  if(config.width===320){await page.setViewportSize({width:320,height:300});await review.click();await page.getByRole('dialog').locator('summary').click();await modalFits(page,'short visual viewport');await page.keyboard.press('Escape');}
  results.push({configuration:config,geometry});
 });
 for(const width of [320,390,768,1024,1920])await scenario(`PDF opens natively without downloading at ${width}px`,async()=>{
  const page=student.page;active=page;await page.setViewportSize({width,height:width===320?568:900});
  const requests=[];const listen=request=>requests.push(request.url());page.on('request',listen);
  await page.goto(origin+'/app/library?semester=1&module=Responsive+PDF');
  const card=page.locator('#resource-'+own.id);await expect(card).toBeVisible();
  const link=card.locator('a.document-main');await expect(link).toHaveAttribute('href','/api/files/'+own.id);await expect(link).not.toHaveAttribute('download',/.*/);
  const downloads=[];const onPage=p=>p.on('download',d=>downloads.push(d.suggestedFilename()));student.context.on('page',onPage);
  const [popup,response]=await Promise.all([page.waitForEvent('popup'),student.context.waitForEvent('response',{predicate:r=>new URL(r.url()).pathname==='/api/files/'+own.id}),link.click()]);
  await popup.setViewportSize({width,height:width===320?568:900});
  assert.equal(response.status(),200);assert.match(response.headers()['content-type'],/^application\/pdf/);assert.match(response.headers()['content-disposition'],/^inline;/);assert.equal(response.headers()['cache-control'],'private, no-store');
  await expect(popup).toHaveURL(new RegExp('/api/files/'+own.id+'$'));
  if(headed){
   await expect.poll(()=>popup.frames().some(frame=>frame.url().startsWith('chrome-extension:'))).toBe(true);
   const viewer=popup.frames().find(frame=>frame.url().startsWith('chrome-extension:'));
   await viewer.waitForFunction(()=>document.querySelector('pdf-viewer')?.loadState_==='success',{},{timeout:20000});
   assert.equal(await viewer.evaluate(()=>document.querySelector('pdf-viewer').loadProgress_),100,'Native PDF rendering completes');
   await popup.screenshot({path:`${out}/native-${width}.png`});
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(requests.some(url=>/\/reading\//.test(url)||/pdf(?:\.worker)?-[\w-]+\.js/.test(url)),false,'Ordinary PDF opening must not load PDF.js or the study reader');
  assert.deepEqual(downloads,[],'Viewing does not trigger an automatic download');
  await expect.poll(async()=>!!await env.db.prepare('SELECT resource_id FROM history WHERE user_id=3 AND resource_id=?').get(own.id)).toBe(true);
  await fits(page,'library '+width);await page.screenshot({path:`${out}/library-${width}.png`});
  await popup.close();page.off('request',listen);student.context.off('page',onPage);
 });
 await scenario('PDF permissions, ranges, explicit downloads and source versions stay enforced',async()=>{
  const get=(path,headers)=>student.context.request.get(origin+path,{headers});
  const inline=await get('/api/files/'+own.id,{range:'bytes=0-4'});assert.equal(inline.status(),206);assert.equal((await inline.body()).toString(),'%PDF-');assert.equal(inline.headers()['accept-ranges'],'bytes');
  const download=await get('/api/files/'+own.id+'?download=1');assert.match(download.headers()['content-disposition'],/^attachment;/);
  const guest=await actor();assert.equal((await guest.context.request.get(origin+'/api/files/'+own.id)).status(),401);
  assert.equal((await get('/api/files/'+foreign.id)).status(),403);
  assert.equal((await get('/api/reading/'+foreign.id+'/file?version=1')).status(),403);
  assert.equal((await get('/api/reading/'+own.id+'/file?version=999')).status(),404);
  const source=nativePDFUrl({id:own.id,fileType:'PDF',initialPage:2,initialVersion:1,url:'https://untrusted.invalid/file?download=1'});
  assert.equal(source,`/api/reading/${own.id}/file?version=1#page=2`);assert.equal((await get(source.split('#')[0])).status(),200);
  assert.equal(nativePDFUrl({id:'../other',fileType:'PDF'}),null);
  assert.equal(nativePDFUrl({id:own.id,fileType:'TXT'}),null);
 });
 await scenario('Notes and study tools remain an explicit optional action',async()=>{
  const page=student.page;active=page;await page.setViewportSize({width:390,height:844});await page.goto(origin+'/app/library?semester=1&module=Responsive+PDF');
  await page.locator('#resource-'+own.id).getByRole('button',{name:/^Outils d’étude/}).click();await expect(page.locator('.study-reader-modal')).toBeVisible();await expect(page.locator('.reader-continuous-pages canvas').first()).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(origin+'/app/study');await page.getByRole('button',{name:'Nouvelle note',exact:true}).click();await modalFits(page,'private note');await page.keyboard.press('Escape');
 });
 await scenario('Deep PDF source links retain page, version and history without duplicate tabs',async()=>{
  await env.db.prepare('DELETE FROM history WHERE user_id=3 AND resource_id=?').run(own.id);
  const page=await student.context.newPage();active=page;const popups=[];page.on('popup',popup=>popups.push(popup));
  await page.goto(origin+`/app/library?document=${own.id}&page=2&version=1`);
  await expect(page).toHaveURL(origin+`/api/reading/${own.id}/file?version=1#page=2`);
  await expect.poll(async()=>!!await env.db.prepare('SELECT resource_id FROM history WHERE user_id=3 AND resource_id=?').get(own.id)).toBe(true);
  assert.equal(popups.length,0);await page.close();
 });
 await scenario('Non-PDF previews keep their existing text viewer',async()=>{
  const text=await resource('flaa','french_studies',true),page=student.page;active=page;await page.goto(origin+'/app/library?semester=1&module=Responsive+PDF');
  await page.locator('#resource-'+text.id+' .document-main').click();await expect(page.locator('.reader-text-document')).toContainText('Isolated text preview remains readable.');await page.keyboard.press('Escape');
 });
 await scenario('Other modals keep forms, report decisions, uploads and chat actions reachable',async()=>{
  const response=await student.context.request.post(origin+'/api/reports',{data:{target_type:'resource',target_id:own.id,reason:'incorrect',details:'Isolated responsive review of a long report description.'}});
  assert.equal(response.status(),201);const {id}=await response.json();
  for(const width of [320,768,1440]){
   const page=admin.page;active=page;await page.setViewportSize({width,height:width===320?568:900});
   await page.goto(origin+`/app/admin?tab=reports&report=${id}#report-${id}`);await expect(page.locator('.admin-report-modal')).toBeVisible();await modalFits(page,'report '+width);
   await expect(page.locator('.admin-report-modal .modal-footer .btn')).toHaveCount(4);if(width===320)assert.ok((await page.locator('.admin-report-modal .modal-footer').boundingBox()).height<=156,'Report decisions stay compact with readable labels');await page.screenshot({path:`${out}/report-${width}.png`});await page.keyboard.press('Escape');
   await page.goto(origin+`/app/admin?tab=resources&resource=${own.id}`);await expect(page.locator('#admin-resource-form')).toBeVisible();await modalFits(page,'resource '+width);await page.keyboard.press('Escape');
   await page.goto(origin+'/app/admin?tab=announcements');await page.getByRole('button',{name:'Rédiger une annonce',exact:true}).click();await modalFits(page,'announcement '+width);await page.keyboard.press('Escape');
   const studentPage=student.page;active=studentPage;await studentPage.setViewportSize({width,height:width===320?568:900});await studentPage.goto(origin+'/app/library');
   await studentPage.getByRole('button',{name:'Partager un document',exact:true}).first().click();await expect(studentPage.locator('.upload-modal')).toBeVisible();
   if(width===320)assert.ok((await studentPage.locator('.upload-dropzone').boundingBox()).height<=240,'The phone file picker does not consume the entire modal');
   const [picker]=await Promise.all([studentPage.waitForEvent('filechooser'),studentPage.getByRole('dialog').getByRole('button',{name:'Choisir des fichiers',exact:true}).click()]);
   await picker.setFiles({name:'responsive-only.txt',mimeType:'text/plain',buffer:Buffer.from('Temporary browser file, never submitted.')});
   await expect(studentPage.locator('.upload-dropzone')).toHaveClass(/has-files/);
   if(width===320)assert.ok((await studentPage.locator('.upload-dropzone').boundingBox()).height<=180,'Selected files leave room for the file list');
   const [folderPicker]=await Promise.all([studentPage.waitForEvent('filechooser'),studentPage.getByRole('dialog').getByRole('button',{name:'Choisir un dossier',exact:true}).click()]);
   assert.notEqual(await folderPicker.element().getAttribute('webkitdirectory'),null);await folderPicker.setFiles(folderFixture);
   await expect(studentPage.locator('.upload-modal')).toContainText('folder-note.txt');
   await modalFits(studentPage,'upload '+width);await studentPage.screenshot({path:`${out}/upload-${width}.png`});await studentPage.keyboard.press('Escape');
   await studentPage.goto(origin+'/app/community?channel=general');await studentPage.getByRole('button',{name:'Messages épinglés',exact:true}).click();await modalFits(studentPage,'chat pins '+width);await studentPage.keyboard.press('Escape');
   await studentPage.goto(origin+'/app/profile');await studentPage.getByRole('main').getByRole('button',{name:'Contacter l’administration',exact:true}).click();await modalFits(studentPage,'contact '+width);await studentPage.keyboard.press('Escape');
  }
 });
 await scenario('Explicitly saved offline PDFs remain readable without opening a broken native tab',async()=>{
  const offline=await actor('yassine',390,844,'dark',true),page=offline.page;active=page;
  await page.goto(origin+'/app/library?semester=1&module=Responsive+PDF');await page.locator('#resource-'+own.id).getByRole('button',{name:/^Outils d’étude/}).click();
  await expect(page.locator('.reader-continuous-pages canvas').first()).toBeVisible();
  await page.locator('.reader-pane-active .reader-tools-toggle').click();await page.getByRole('button',{name:'Enregistrer hors ligne',exact:true}).click();
  await expect(page.locator('.reader-offline-controls')).toContainText('Disponible hors ligne');await page.keyboard.press('Escape');
  const popups=[];page.on('popup',popup=>popups.push(popup));await offline.context.setOffline(true);
  try{
   await page.locator('#resource-'+own.id+' .document-main').click();await expect(page.locator('.reader-continuous-pages canvas').first()).toBeVisible();
   await expect(page.locator('.reader-status-bar')).toContainText('Hors ligne');assert.equal(popups.length,0);await fits(page,'offline PDF');
  }finally{await offline.context.setOffline(false);}
 });
 await scenario('Modal keyboard focus recovers after a disabled control and Select Escape stays local',async()=>{
  const page=admin.page;active=page;await page.setViewportSize({width:390,height:844});await page.goto(origin+'/app/admin?tab=accounts');
  await page.locator('[data-account-id="3"]').getByRole('button',{name:'Consulter Yassine',exact:true}).click();
  let modal=page.getByRole('dialog');await modal.locator('.modal-header .icon-btn').focus();await page.keyboard.press('Shift+Tab');await expect(modal.getByRole('button',{name:'Modifier',exact:true})).toBeFocused();
  await modal.getByRole('button',{name:'Modifier',exact:true}).click();modal=page.getByRole('dialog');
  const role=modal.getByRole('combobox',{name:'Rôle',exact:true});await role.focus();await role.press('ArrowDown');await expect(page.getByRole('listbox')).toBeVisible();await role.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);await expect(modal).toBeVisible();
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Tab');await expect(modal.locator('.modal-header .icon-btn')).toBeFocused();
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');await expect(modal).toHaveCount(0);
 });
 assert.deepEqual(errors,[]);await writeFile(resultFile,JSON.stringify({results,errors},null,2));console.log('PASS responsive actions and native PDF integration');
}catch(error){console.error(error);await active?.screenshot({path:out+'/failure.png'}).catch(()=>{});await writeFile(resultFile,JSON.stringify({results,errors,failure:String(error)},null,2));process.exitCode=1;}
finally{for(const context of contexts)await context.close();await browser.close();env.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await env.close();await rm(folderFixture,{recursive:true,force:true});}
