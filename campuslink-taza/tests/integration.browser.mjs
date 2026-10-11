import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createTestApp} from './backend-helpers.mjs';
import {chooseOption,classifyChatFiles} from './ui.helpers.mjs';

// Real application routes and disposable PostgreSQL metadata. Explicit test
// identity/storage doubles never create provider users or alter source files.
const environment=await createTestApp({appOrigin:'http://127.0.0.1:5182'});
const server=environment.app.listen(5182,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:5182';
const installed='/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser=await chromium.launch({headless:true,...(existsSync(installed)?{executablePath:installed}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
const passed=[],failures=[];
await mkdir('test-results',{recursive:true});
async function scenario(name,run){await run();passed.push(name);console.log('PASS '+name);}
async function pageFor({mobile=false}={}){
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},hasTouch:mobile,isMobile:mobile});
 await context.addInitScript(()=>{
  // Private previews contain sandboxed frames without storage access.
  try{window.localStorage?.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');}catch{}
 });
 const page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',error=>failures.push(error.message));
 page.on('response',response=>{if(response.status()>=500&&response.url().startsWith(origin+'/api/'))console.error(`API ${response.request().method()} ${new URL(response.url()).pathname}: ${response.status()}`);});
 await page.goto(origin+'/login');await expect(page.locator('#login-username')).toBeVisible();return {context,page};
}
async function login(page,username,password='Campus2026!'){
 await page.locator('#login-username').fill(username);await page.locator('#login-password').fill(password);await page.getByRole('button',{name:'Se connecter',exact:true}).click();await expect(page.locator('.app-shell')).toBeVisible();
}
async function json(page,path,options={}){const response=await page.request.fetch(origin+'/api'+path,options);const data=await response.json();assert.ok(response.ok(),`${options.method||'GET'} ${path}: ${response.status()} ${data.error||''}`);return data;}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal page overflow');}
let active;
try{
 await scenario('Browser demo state cannot create a session or grant administrator access',async()=>{
  const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('campuslink-prototype-v1:session',JSON.stringify({id:2,username:'admin',role:'global_admin',name:'Forged admin'})));const page=await context.newPage();active=page;await page.goto(origin+'/app/admin');await expect(page.locator('#login-username')).toBeVisible();await expect(page.locator('.app-shell')).toHaveCount(0);await context.close();
 });
 await scenario('Student signs in with server session; reload preserves academic context and private previews',async()=>{
  const {context,page}=await pageFor();active=page;await login(page,'sara');await expect(page.locator('.home-welcome')).toBeVisible();
  const bootstrap=await json(page,'/bootstrap');assert.equal(bootstrap.user.filiere_id,'french_studies');assert.ok(bootstrap.resources.length>0);
  await page.reload();await expect(page.locator('.home-welcome')).toBeVisible();assert.equal((await json(page,'/session')).user.username,'sara');
  await page.goto(origin+'/app/library');await page.locator('.library-module-folder').first().click();const card=page.locator('.document-card').first();await expect(card).toBeVisible();
  const title=await card.locator('h3').innerText();await card.locator('.save-btn').click();await expect(card.locator('.save-btn')).toHaveAttribute('aria-pressed','true');await expect(card.locator('.save-btn')).toBeEnabled();
  await card.locator('.document-main').click();await expect(page.locator('.preview-modal')).toBeVisible();await expect(page.locator('.preview-modal')).toContainText(title);
  const document=(await json(page,'/bootstrap')).resources.find(item=>item.title===title);assert.ok(document);const bytes=await page.request.get(origin+'/api/files/'+document.id);assert.equal(bytes.status(),200);assert.ok((await bytes.body()).subarray(0,4).equals(Buffer.from('%PDF')));
  await page.keyboard.press('Escape');await page.reload();await expect(page.locator('.document-card').filter({hasText:title}).locator('.save-btn')).toHaveAttribute('aria-pressed','true');
  assert.ok((await json(page,'/bootstrap')).history.some(item=>item.resource_id===document.id));await context.close();
 });
 await scenario('Library uploads complete classification and original bytes persist after reload',async()=>{
  const {context,page}=await pageFor();active=page;await login(page,'sara');await page.goto(origin+'/app/library');await page.getByRole('button',{name:'Partager un document',exact:true}).first().click();
  const modal=page.getByRole('dialog');await modal.locator('input[type=file]:not([webkitdirectory])').setInputFiles({name:'integration-library.txt',mimeType:'text/plain',buffer:Buffer.from('Persisted frontend library upload\n')});
  await modal.getByRole('button',{name:/^Classer les documents/}).click();const row=modal.locator('.upload-file').first();await row.getByRole('button',{name:/^Modifier /}).click();const editor=row.locator('.upload-file-editor');
  await modal.locator('.upload-batch').getByLabel(/^Module/).fill('Module intégration frontend');await editor.getByLabel(/^Part\/Chapitre/).fill('Complet');
  await modal.getByRole('button',{name:/^Vérifier/}).click();await expect(modal.locator('.upload-review-list')).toBeVisible();await modal.getByRole('button',{name:/^Confirmer|^Envoyer|^Partager/}).last().click();
  await expect(modal.getByRole('heading',{name:'Documents ajoutés'})).toBeVisible({timeout:45000});await modal.getByRole('button',{name:'Terminer',exact:true}).click();
  const data=await json(page,'/bootstrap'),file=data.resources.find(item=>item.filename==='integration-library.txt');assert.ok(file);assert.equal(file.part_number,'complete');assert.equal(file.module,'Module intégration frontend');assert.equal(file.library_visible,true);
  assert.equal((await page.request.get(origin+'/api/files/'+file.id)).status(),200);await page.reload();await page.getByRole('button',{name:'Ouvrir le module MODULE INTÉGRATION FRONTEND',exact:true}).click();await expect(page.locator('.document-card').filter({hasText:'integration-library'})).toBeVisible();await context.close();
 });
 await scenario('Chat send, multi-file classification, reactions and reload use actual API records',async()=>{
  const {context,page}=await pageFor({mobile:true});active=page;await login(page,'sara');await page.addInitScript(()=>Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));await page.goto(origin+'/app/community?channel=general');assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');await expect(page.locator('.community-composer')).toBeVisible();
  const before=await json(page,'/bootstrap');await page.locator('.community-device-file-input').setInputFiles([{name:'chat-alpha.txt',mimeType:'text/plain',buffer:Buffer.from('Chat attachment alpha\n')},{name:'chat-beta.txt',mimeType:'text/plain',buffer:Buffer.from('Chat attachment beta\n')}]);
  await classifyChatFiles(page,'Module pièces jointes réel');await page.getByRole('textbox',{name:'Votre message',exact:true}).fill('Message intégré avec deux fichiers');await page.locator('.community-composer').getByRole('button',{name:/Envoyer le message/}).click();
  const bubble=page.locator('.community-message').filter({hasText:'Message intégré avec deux fichiers'});await expect(bubble).toBeVisible({timeout:45000});await expect(bubble).not.toHaveClass(/is-sending|is-failed/,{timeout:45000});
  const data=await json(page,'/bootstrap'),message=data.messages.find(item=>item.content==='Message intégré avec deux fichiers');assert.ok(message);assert.equal(message.attachments.length,2);assert.equal(data.resources.length,before.resources.length);
  for(const file of message.attachments){assert.equal(file.library_visible,false);assert.equal(file.module,'Module pièces jointes réel');assert.equal((await page.request.get(origin+'/api/files/'+file.id)).status(),200);}
  await bubble.focus();await bubble.press('Shift+F10');await page.getByRole('menuitemcheckbox',{name:'Utile',exact:true}).click();
  await expect(bubble.getByRole('button',{name:'Utile · 1',exact:true})).toHaveAttribute('aria-pressed','true');
  await bubble.focus();await bubble.press('Shift+F10');await page.getByRole('menuitemcheckbox',{name:'J’aime',exact:true}).click();
  await expect(bubble.getByRole('button',{name:'J’aime · 1',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect.poll(async()=>(await json(page,'/messages/'+message.id)).message.my_reactions.length).toBe(2);const reacted=(await json(page,'/messages/'+message.id)).message;assert.equal(reacted.reactions.like,1);assert.equal(reacted.reactions.heart,1);assert.deepEqual([...reacted.my_reactions].sort(),['heart','like']);
  await page.reload();const persisted=page.locator('.community-message').filter({hasText:'Message intégré avec deux fichiers'});await expect(persisted).toBeVisible();
  await expect(persisted.getByRole('button',{name:'Utile · 1',exact:true})).toHaveAttribute('aria-pressed','true');await expect(persisted.getByRole('button',{name:'J’aime · 1',exact:true})).toHaveAttribute('aria-pressed','true');
  await noOverflow(page);await page.screenshot({path:'test-results/integration-chat-mobile.png'});await context.close();
 });
 await scenario('Profile changes and independent notification preferences persist on server',async()=>{
  const {context,page}=await pageFor();active=page;await login(page,'sara');await page.goto(origin+'/app/profile');await page.getByLabel('Nom affiché',{exact:true}).fill('Sara Intégration');await page.getByLabel('À propos',{exact:true}).fill('Profil enregistré dans PostgreSQL');await page.getByRole('button',{name:'Enregistrer les modifications',exact:true}).click();
  await expect.poll(async()=>(await json(page,'/session')).user.name).toBe('Sara Intégration');
  const preferences=page.locator('#preferences'),resources=preferences.getByRole('checkbox',{name:'Nouvelles ressources',exact:true}),administration=preferences.getByRole('checkbox',{name:'Messages de l’administration',exact:true});
  const initialPreferences=(await json(page,'/session')).user.preferences;
  await resources.click();await expect(resources).not.toBeChecked();await expect.poll(async()=>(await json(page,'/session')).user.preferences.resources).toBe(false);
  await administration.click();await expect(administration).not.toBeChecked();await expect.poll(async()=>(await json(page,'/session')).user.preferences.admin).toBe(false);
  const savedPreferences=(await json(page,'/session')).user.preferences;assert.equal(savedPreferences.resources,false);assert.equal(savedPreferences.admin,false);
  for(const key of ['announcements','mentions','important'])assert.equal(savedPreferences[key],initialPreferences[key]!==false,key+' remains independent');assert.equal('calendar' in savedPreferences,false);
  await page.reload();await expect(page.getByLabel('Nom affiché',{exact:true})).toHaveValue('Sara Intégration');assert.equal((await json(page,'/session')).user.bio,'Profil enregistré dans PostgreSQL');
  await expect(page.locator('#preferences').getByRole('checkbox',{name:'Nouvelles ressources',exact:true})).not.toBeChecked();await expect(page.locator('#preferences').getByRole('checkbox',{name:'Messages de l’administration',exact:true})).not.toBeChecked();await context.close();
 });
 await scenario('Student semester changes through profile settings persist across reloads',async()=>{
  const {context,page}=await pageFor();active=page;await login(page,'sara');await page.goto(origin+'/app/profile');
  const initial=(await json(page,'/session')).user,semester=Number(initial.current_semester),nextSemester=semester===1?2:1;
  const academic=page.locator('.academic-settings');await expect(academic).toBeVisible();
  await chooseOption(academic.getByRole('combobox',{name:'Votre semestre actuel',exact:true}),String(nextSemester));
  await academic.getByRole('button',{name:'Enregistrer mon parcours',exact:true}).click();
  await expect.poll(async()=>(await json(page,'/session')).user.current_semester).toBe(nextSemester);
  assert.equal((await json(page,'/session')).user.filiere_id,initial.filiere_id);await page.reload();
  await expect(page.locator('.academic-settings').getByRole('combobox',{name:'Votre semestre actuel',exact:true})).toContainText('S'+nextSemester);
  assert.equal((await json(page,'/bootstrap')).user.current_semester,nextSemester);
  await chooseOption(page.locator('.academic-settings').getByRole('combobox',{name:'Votre semestre actuel',exact:true}),String(semester));
  await page.locator('.academic-settings').getByRole('button',{name:'Enregistrer mon parcours',exact:true}).click();
  await expect.poll(async()=>(await json(page,'/session')).user.current_semester).toBe(semester);await page.reload();
  await expect(page.locator('.academic-settings').getByRole('combobox',{name:'Votre semestre actuel',exact:true})).toContainText('S'+semester);await context.close();
 });
 await scenario('Global administrator retains existing eight tabs with real accounts and publications',async()=>{
  const {context,page}=await pageFor();active=page;await login(page,'admin','Admin2026!');await expect(page.locator('.admin-page')).toBeVisible();await expect(page.locator('.admin-page [role=tab]')).toHaveCount(8);
  await page.goto(origin+'/app/admin?tab=accounts');await expect(page.locator('.admin-page')).toContainText('Sara Intégration');await page.goto(origin+'/app/admin?tab=organization');await expect(page.locator('.admin-page')).toContainText('FSA');
  await page.goto(origin+'/app/admin?tab=announcements');await page.getByRole('button',{name:'Rédiger une annonce',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByLabel(/^Titre/).fill('Publication réelle frontend');await modal.getByLabel(/^Contenu|^Message/).fill('Annonce publiée par les routes administratives migrées.');await modal.getByRole('button',{name:/^Publier/}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.admin-page')).toContainText('Publication réelle frontend');
  await page.reload();await expect(page.locator('.admin-page')).toContainText('Publication réelle frontend');await page.screenshot({path:'test-results/integration-admin-desktop.png'});await context.close();
 });
 await scenario('Student registration waits for admission and opens the campus after real approval',async()=>{
  const {context,page}=await pageFor({mobile:true});active=page;await page.goto(origin+'/register');await page.locator('#register-name').fill('Étudiant Validation');await page.locator('#register-username').fill('validation.ui');await page.locator('#register-email').fill('validation.ui@campuslink.test');await page.locator('#register-password').fill('Frontend2026!');await chooseOption(page.locator('#register-faculty'),'flaa');await chooseOption(page.locator('#register-filiere'),'french_studies');await chooseOption(page.locator('#register-semester'),'2');await page.getByRole('button',{name:'Créer un compte',exact:true}).click();await expect(page).toHaveURL(/account-review/);await expect(page.locator('.onboarding-heading')).toContainText('en attente');assert.equal((await page.request.get(origin+'/api/bootstrap')).status(),403);
  const registered=(await json(page,'/session')).user;assert.equal(registered.account_status,'pending');const administrator=await pageFor();await login(administrator.page,'admin','Admin2026!');await json(administrator.page,'/admin/users/'+registered.id+'/admission',{method:'PATCH',data:{status:'approved'}});await page.getByRole('button',{name:'Vérifier le statut',exact:true}).click();await expect(page.locator('.home-welcome')).toBeVisible();await page.reload();await expect(page.locator('.home-welcome')).toContainText('Étudiant');await noOverflow(page);await administrator.context.close();await context.close();
 });
 await scenario('Removed calendar stays absent from navigation, notifications and publication routes',async()=>{
  const administrator=await pageFor();active=administrator.page;await login(administrator.page,'admin','Admin2026!');
  const retired=await administrator.page.request.post(origin+'/api/admin/events',{data:{title:'Retired event',date:'2026-11-12',time:'09:30',type:'exam',faculty_id:'flaa'}});assert.equal(retired.status(),410);
  await administrator.page.goto(origin+'/app/admin?tab=announcements');await expect(administrator.page.getByRole('button',{name:'Ajouter un événement',exact:true})).toHaveCount(0);await expect(administrator.page.locator('#admin-events-title')).toHaveCount(0);
  const {context,page}=await pageFor({mobile:true});active=page;await login(page,'sara');await expect(page.locator('a[href="/app/calendar"]')).toHaveCount(0);
  await page.goto(origin+'/app/calendar');await expect(page).toHaveURL(origin+'/app');
  const boot=await json(page,'/bootstrap');assert.deepEqual(boot.events,[]);assert.ok(boot.notifications.every(item=>item.type!=='calendar'&&!item.path?.includes('/calendar')));
  await noOverflow(page);await administrator.context.close();await context.close();
 });
 await scenario('Source faculty and moderator permissions remain enforced by UI and API',async()=>{
  const faculty=await pageFor();active=faculty.page;await login(faculty.page,'professeure');await faculty.page.goto(origin+'/app/admin?tab=accounts');await expect(faculty.page.locator('.admin-page')).toBeVisible();
  await expect(faculty.page.locator('.admin-page [role=tab]')).toHaveCount(8);await expect(faculty.page.getByRole('button',{name:'Ajouter un compte',exact:true})).toBeDisabled();await expect(faculty.page.locator('#admin-admissions-title')).toHaveCount(0);
  const records=await json(faculty.page,'/admin');assert.ok(records.users.length>0);assert.ok(records.users.every(item=>item.faculty_id==='flaa'));assert.ok(records.resources.every(item=>item.faculty_id==='flaa'));
  assert.equal((await faculty.page.request.get(origin+'/api/admin/registrations')).status(),403);assert.equal((await faculty.page.request.get(origin+'/api/chat/blocks')).status(),403);await faculty.context.close();
  const {context,page}=await pageFor();active=page;await login(page,'amina');await page.goto(origin+'/app/admin');await expect(page.locator('.admin-page')).toBeVisible();await expect(page.locator('.admin-page [role=tab]')).toHaveCount(3);const denied=await page.request.get(origin+'/api/admin/registrations');assert.equal(denied.status(),403);await context.close();
 });
 assert.deepEqual(failures,[],'No browser runtime errors');
} catch(error){if(active&&!active.isClosed())await active.screenshot({path:'test-results/integration-failure.png',fullPage:true}).catch(()=>{});failures.push(error.stack);process.exitCode=1;}
finally{
 await writeFile('test-results/integration-report.json',JSON.stringify({passed,failures},null,2));await browser.close();environment.app.locals.endStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await environment.close();
}
if(failures.length)throw new Error(failures.join('\n'));
