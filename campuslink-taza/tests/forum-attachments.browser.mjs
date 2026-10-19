import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';

const origin=process.env.CAMPUSLINK_TEST_URL||'http://127.0.0.1:5198';
const executablePath='/home/issmail/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const browser=await chromium.launch({...(existsSync(executablePath)?{executablePath}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const passed=[];let activePage;mkdirSync('test-results',{recursive:true});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
const attachment=(id,filename,mime='text/plain',canDelete=true)=>({id,filename,mime,size:42,url:`/api/campus/forum/81/attachments/${id}/file`,can_delete:canDelete});
function multipart(request){
 const raw=request.postDataBuffer().toString('utf8'),boundary=/boundary=(?:"([^"]+)"|([^;]+))/.exec(request.headers()['content-type']);let filename,clientId;
 for(const part of raw.split('--'+(boundary[1]||boundary[2]))){const separator=part.indexOf('\r\n\r\n');if(separator<0)continue;const headers=part.slice(0,separator),name=/\bname="([^"]+)"/.exec(headers)?.[1],file=/\bfilename="([^"]+)"/.exec(headers)?.[1];if(file)filename=file;else if(name==='client_id')clientId=part.slice(separator+4).replace(/\r\n$/,'');}
 return {filename,clientId,raw};
}
async function fixture({canUpload=true,initial=[],failSecond=false,knownFailed=false,delayed=false,width=390}={}){
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<800,hasTouch:width<800,serviceWorkers:'block',reducedMotion:'reduce'});
 const user={id:3,name:'Forum fixture',username:'forum-fixture',role:'student',account_status:'approved',faculty_id:'flaa',filiere_id:'french_studies',current_semester:1,language:'fr'};
 const question={id:81,title:'QUESTION WITH FILES',body:'Student authored question.',module:'Literature',author_id:3,author:{id:3,name:'Forum fixture',role:'student'},resource_id:null,source_page:null,source_version:null,source_anchor:[]};
 const items=[...initial],writes=[],imageRequests=[],errors=[];let failed=false,count=0,denied=false;
 await context.addInitScript(()=>{window.EventSource=undefined;localStorage.setItem('campuslink-prototype-v1:language','"fr"');localStorage.setItem('campuslink-prototype-v1:theme','"dark"');localStorage.setItem('campuslink-prototype-v1:install-prompt-seen-v1','true');});
 await context.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/api/session')return route.fulfill({json:{user}});
  if(path==='/api/bootstrap')return route.fulfill({json:{user,resources:[],messages:[],notifications:[],announcements:[],channels:[],members:[],saved:[],history:[]}});
  if(path==='/api/campus/forum/81')return route.fulfill({json:{question,answers:[],comments:[]}});
  if(path==='/api/campus/forum/81/attachments'&&request.method()==='GET')return denied?route.fulfill({status:403,json:{error:'Accès aux fichiers retiré.'}}):route.fulfill({json:{attachments:items,can_upload:canUpload,limits:{maxFiles:5,maxFileBytes:20971520,maxTotalBytes:52428800}}});
  if(path==='/api/campus/forum/81/attachments'&&request.method()==='POST'){
   const body=multipart(request);writes.push(body);count++;
   if(delayed)await new Promise(resolve=>setTimeout(resolve,350));
   if(knownFailed&&count===1)return route.fulfill({status:503,json:{error:'Stockage temporairement indisponible.'}});
   if(knownFailed&&count===2)return route.fulfill({status:409,json:{error:'Le dépôt précédent a échoué. Réessayez explicitement.',code:'ATTACHMENT_RETRY_REQUIRED'}});
   if(failSecond&&body.filename==='second.csv'&&!failed){failed=true;return route.fulfill({status:502,json:{error:'Échec temporaire du deuxième fichier.'}});}
   const item=attachment('file-'+(items.length+1),body.filename);items.push(item);return route.fulfill({status:201,json:{attachment:item,reused:false}}).catch(()=>{});
  }
  const itemRoute=/^\/api\/campus\/forum\/81\/attachments\/([^/]+)$/.exec(path);
  if(itemRoute&&request.method()==='DELETE'){writes.push({method:'DELETE',id:itemRoute[1]});items.splice(items.findIndex(item=>item.id===itemRoute[1]),1);return route.fulfill({json:{ok:true}});}
  if(path.endsWith('/file')){imageRequests.push(path);return route.fulfill({contentType:'image/png',body:png});}
  return route.fulfill({json:{}});
 });
 const page=await context.newPage();activePage=page;page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/app/campus?tab=forum&question=81');
 await page.locator('.forum-attachments').waitFor({timeout:30000});
 const panel=page.getByRole('region',{name:'Pièces jointes de la question',exact:true});await expect(panel.getByRole('button',{name:'Actualiser les fichiers',exact:true})).toBeEnabled();
 return {context,page,panel,items,writes,imageRequests,errors,deny:()=>{denied=true;}};
}
async function scenario(name,run){await run();passed.push(name);console.log('PASS '+name);}
async function select(f,files=[{name:'first.py',mimeType:'text/plain',buffer:Buffer.from('print("user-authored")')},{name:'second.csv',mimeType:'text/csv',buffer:Buffer.from('name,value\na,1')}]){await f.panel.getByLabel('Ajouter des fichiers à ma question',{exact:true}).setInputFiles(files);}
try{
 await scenario('Question author uploads multipart files sequentially and retries only the failed selection on mobile',async()=>{const f=await fixture({failSecond:true});try{
  await select(f);await f.panel.getByRole('button',{name:'Joindre les fichiers sélectionnés',exact:true}).dblclick();await expect(f.panel.getByRole('alert')).toContainText('Échec temporaire');await expect(f.panel.locator('.forum-attachment-list>li')).toHaveCount(1);await expect(f.panel.locator('.forum-attachment-queue>li')).toHaveCount(1);
  await f.panel.getByRole('button',{name:'Joindre les fichiers sélectionnés',exact:true}).click();await expect(f.panel.locator('.forum-attachment-list>li')).toHaveCount(2);await expect(f.panel.locator('.forum-attachment-queue>li')).toHaveCount(0);
  assert.deepEqual(f.writes.map(item=>item.filename),['first.py','second.csv','second.csv']);assert.equal(f.writes[1].clientId,f.writes[2].clientId);assert.ok(f.writes.every(item=>/^[a-f0-9-]{36}$/.test(item.clientId)));assert.ok(f.writes.every(item=>!item.raw.includes('name="faculty_id"')));
  await f.panel.getByRole('button',{name:'Retirer first.py',exact:true}).click();await expect(f.panel.locator('.forum-attachment-list>li')).toHaveCount(1);assert.equal(f.writes.at(-1).method,'DELETE');
  const width=await f.page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.ok(width.scroll<=width.width+1,JSON.stringify(width));assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}});
 await scenario('Peer files stay inert and images load only after explicit viewing with server-controlled removal',async()=>{const f=await fixture({canUpload:false,initial:[attachment('photo','notebook.png','image/png',false),attachment('code','example.html','text/html',false),attachment('svg','diagram.svg','image/svg+xml',false)]});try{
  await expect(f.panel.getByLabel('Ajouter des fichiers à ma question',{exact:true})).toHaveCount(0);assert.equal(f.imageRequests.length,0);await expect(f.panel.locator('img')).toHaveCount(0);await expect(f.panel.getByRole('button',{name:'Afficher l’image',exact:true})).toHaveCount(1);await expect(f.panel.getByRole('button',{name:/^Retirer /})).toHaveCount(0);
  await expect(f.panel.getByRole('link',{name:'Télécharger example.html',exact:true})).toHaveAttribute('href','/api/campus/forum/81/attachments/code/file?download=1');await expect(f.panel.getByRole('link',{name:'Télécharger example.html',exact:true})).toHaveAttribute('download','');
  await f.panel.getByRole('button',{name:'Afficher l’image',exact:true}).click();await expect(f.panel.locator('img')).toBeVisible();await f.page.waitForFunction(()=>document.querySelector('.forum-attachment-image')?.naturalWidth>0);assert.equal(f.imageRequests.length,1);await expect(f.panel.locator('iframe,object,embed,script')).toHaveCount(0);
  await f.panel.getByRole('button',{name:'Masquer l’image',exact:true}).click();await expect(f.panel.locator('img')).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}});
 await scenario('Terminal upload failure retains the file and rotates its retry UUID only after server rejection',async()=>{const f=await fixture({knownFailed:true,width:1280});try{
  await select(f,[{name:'proof.txt',mimeType:'text/plain',buffer:Buffer.from('Student evidence')}]);const submit=f.panel.getByRole('button',{name:'Joindre les fichiers sélectionnés',exact:true});await submit.click();await expect(f.panel.getByRole('alert')).toContainText('Stockage temporairement');await submit.click();await expect(f.panel.getByRole('alert')).toContainText('Le dépôt précédent a échoué');await expect(f.panel.locator('.forum-attachment-queue')).toContainText('proof.txt');await submit.click();await expect(f.panel.locator('.forum-attachment-list>li')).toHaveCount(1);assert.equal(f.writes[0].clientId,f.writes[1].clientId);assert.notEqual(f.writes[1].clientId,f.writes[2].clientId);assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}});
 await scenario('Revoked attachment access clears previously loaded private metadata and image previews',async()=>{const f=await fixture({initial:[attachment('photo','private-notebook.png','image/png')]});try{
  await f.panel.getByRole('button',{name:'Afficher l’image',exact:true}).click();await expect(f.panel.locator('img')).toBeVisible();f.deny();await f.panel.getByRole('button',{name:'Actualiser les fichiers',exact:true}).click();await expect(f.panel.getByRole('alert')).toContainText('Accès aux fichiers retiré');await expect(f.panel.locator('img')).toHaveCount(0);await expect(f.panel.getByText('private-notebook.png',{exact:true})).toHaveCount(0);await expect(f.panel.getByLabel('Ajouter des fichiers à ma question',{exact:true})).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}});
 await scenario('Logout aborts an in-flight upload and late responses cannot restore selected files or attachment data',async()=>{const f=await fixture({delayed:true});try{
  await select(f,[{name:'private.txt',mimeType:'text/plain',buffer:Buffer.from('Private user content')}]);await f.panel.getByRole('button',{name:'Joindre les fichiers sélectionnés',exact:true}).click();await f.page.waitForTimeout(30);await f.page.evaluate(()=>window.dispatchEvent(new Event('campus-session-cleared')));await f.page.waitForTimeout(450);await expect(f.panel.locator('.forum-attachment-list>li')).toHaveCount(0);await expect(f.panel.locator('.forum-attachment-queue>li')).toHaveCount(0);await expect(f.panel.getByLabel('Ajouter des fichiers à ma question',{exact:true})).toHaveCount(0);assert.deepEqual(f.errors,[]);
 }finally{await f.context.close();}});
 writeFileSync('test-results/forum-attachments-browser-report.json',JSON.stringify({passed},null,2));
}catch(error){if(activePage&&!activePage.isClosed())await activePage.screenshot({path:'test-results/forum-attachments-browser-failure.png'}).catch(()=>{});writeFileSync('test-results/forum-attachments-browser-report.json',JSON.stringify({passed,error:error.message},null,2));throw error;}
finally{await browser.close();}
