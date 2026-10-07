import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openDatabase, digest } from './db.js';
import { seedDatabase } from './seed.js';
import { createAuthService } from './auth.js';
import { createStorage, resourceObjectKey } from './storage.js';
import { uploadFilePath } from './upload-path.js';
import { slug } from '../shared/paths.js';
import { getFilieres, filiereBelongsToFaculty, getChatSemester, getChatSemesterLabel } from '../shared/studies.js';

const CATEGORIES = ['courses', 'exercises', 'exams', 'rattrapage', 'general'];
const CHANNELS = ['general', 'filiere', 'important', 'help', 'life'];
const ROLES = ['student', 'moderator', 'faculty_admin', 'global_admin'];
const PREF_KEYS = ['resources', 'announcements', 'important', 'admin', 'calendar'];
const RESOURCE_TYPES = ['courses','cours','exercises','exercise','exams','exam','td','tp','correction','image','pdf','document','other','rattrapage'];
const now = () => new Date().toISOString();
const resourcePath = r => `/app/resources/${r.category}${r.semester ? `/s${r.semester}` : ''}${r.module ? `/${encodeURIComponent(slug(r.module))}` : ''}#resource-${r.id}`;
const messagePath = m => `/app/chat/${m.channel}${m.channel==='filiere'?`?semester=${getChatSemester(m.semester)}`:''}#message-${m.id}`;
function problem(status, message) { const e = new Error(message); e.status = status; return e; }
function string(value, name, max = 4000, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw problem(400, `${name} invalide.`);
  return value.trim();
}
function passwordValue(value, label = 'Mot de passe') { if (typeof value !== 'string' || !value.length || value.length > 256) throw problem(400, `${label} invalide.`); return value; }
const asId = value => { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) throw problem(400, 'Identifiant invalide.'); return n; };

function detectFile(buffer, filename) {
  const extension = extname(filename).toLowerCase();
  const magic = buffer.subarray(0, 12);
  if (extension === '.pdf' && magic.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (['.jpg', '.jpeg'].includes(extension) && magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff) return 'image/jpeg';
  if (extension === '.png' && magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (extension === '.gif' && /^GIF8[79]a/.test(magic.toString())) return 'image/gif';
  if (extension === '.webp' && magic.subarray(0, 4).toString() === 'RIFF' && magic.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  const legacyOffice={'.doc':'application/msword','.xls':'application/vnd.ms-excel','.ppt':'application/vnd.ms-powerpoint'};
  if(legacyOffice[extension]&&magic.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225])))return legacyOffice[extension];
  const office = { '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.odt':'application/vnd.oasis.opendocument.text' };
  if (office[extension] && magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04) return office[extension];
  if (extension === '.txt' && !buffer.includes(0)) return 'text/plain';
  throw problem(400, 'Fichier non pris en charge ou contenu invalide. Utilisez un PDF, une image, un document Office ou un fichier texte.');
}

export async function createApp({ db: suppliedDb, auth: suppliedAuth, storage: suppliedStorage, connectionString = process.env.DATABASE_URL, schema, seed = true, appOrigin = process.env.APP_ORIGIN } = {}) {
  const db = suppliedDb || await openDatabase({connectionString,schema});
  const storage = suppliedStorage || createStorage();
  const auth = suppliedAuth || createAuthService({db,appOrigin});
  if (seed) await seedDatabase(db);
  const channelDefaults={general:['Chat général','Échanges autour des cours et de la vie universitaire.'],filiere:['Chats de filière','Échanges de votre filière par semestre.'],important:['Discussions importantes','Informations prioritaires et échéances à retenir.'],help:['Entraide','Questions, révisions et groupes de travail.'],life:['Vie étudiante','Clubs, rencontres et activités sur le campus.']};
  const addChannel=db.prepare('INSERT INTO channels (id,faculty_id,name,description) VALUES (?,?,?,?) ON CONFLICT (id,faculty_id) DO NOTHING');
  for(const faculty of (await db.prepare('SELECT id FROM faculties').all()))for(const [id,[name,description]]of Object.entries(channelDefaults))(await addChannel.run(id,faculty.id,name,description));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));
  const clients = new Map();
  const heartbeats = new Set();
  const attempts = new Map();
  const registrationAttempts = new Map();
  const contactAttempts = new Map();
  const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 20 * 1024 * 1024, files: 1, fields: 12, fieldSize: 10000}});
  app.locals.db = db;
  app.locals.storage = storage;
  app.locals.auth = auth;
  let closed=false;
  app.locals.endStreams = () => { for(const heartbeat of heartbeats)clearInterval(heartbeat);heartbeats.clear();for(const stream of clients.values())for(const res of stream)res.end();clients.clear(); };
  app.locals.close = async () => {if(closed)return;closed=true;app.locals.endStreams();await Promise.all([db.close(),storage.close?.(),auth.close?.()]);};

  app.use('/api', async (req, res, next) => {
    req.body??={};
    if(req.body.faculty_id!==undefined&&req.body.faculty_id!==null&&(typeof req.body.faculty_id!=='string'||req.body.faculty_id.length>30))return next(problem(400,'Faculté invalide.'));
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
      const origin = req.get('origin');
      const allowed = new Set([`${req.protocol}://${req.get('host')}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
      if (appOrigin) allowed.add(appOrigin);
      if ((origin && !allowed.has(origin)) || req.get('sec-fetch-site') === 'cross-site') return next(problem(403, 'Origine de la requête non autorisée.'));
    }
    const authenticated = await auth.authenticate(req,res);
    if (authenticated) {
      req.user = authenticated.user || authenticated;
      req.authSession = authenticated.session || null;
      if(req.user.disabled)throw problem(403,'Ce compte est désactivé.');
      if(req.user.account_status==='deleted')throw problem(401,'Connectez-vous pour accéder à votre communauté.');
      if(req.user.account_status!=='approved') {
        if(!['/session','/login','/logout','/register','/registration-options','/health'].includes(req.path))throw admissionProblem(req.user);
      } else {
        req.user.chat_blocked=await isChatBlocked(req.user);
        await db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(),req.user.id);
      }
    }
    next();
  });

  function publicUser(u) { return {id:u.id, username:u.username, name:u.name, email:u.email, avatar:u.avatar, role:u.role, faculty_id:u.faculty_id, filiere_id:u.filiere_id, current_semester:u.current_semester, language:u.language, preferences:JSON.parse(u.preferences), chat_blocked:!!u.chat_blocked, account_status:u.account_status, registered_at:u.registered_at, reviewed_at:u.reviewed_at, ...(u.disabled !== undefined ? {disabled:!!u.disabled} : {})}; }
  function admissionProblem(u) {
    const pending=u.account_status==='pending';
    return Object.assign(problem(403,pending?'Votre inscription est en attente de validation.':'Votre demande d’inscription a été refusée.'),{code:pending?'ACCOUNT_PENDING':'ACCOUNT_REJECTED'});
  }
  function studentProfile(u) {
    const {account_status,...safe}={...u,role:'student'};
    if(account_status==='deleted'){safe.name='Étudiant supprimé';safe.username='';safe.avatar='';}
    if(String(u.username).toLowerCase()==='admin'){safe.username='issmail';safe.name='Issmail';}
    if(String(u.username).toLowerCase()==='professeure'){safe.username='ancien-membre';safe.name='Ancien membre';}
    if(typeof safe.avatar==='string'&&/admin/i.test(safe.avatar))safe.avatar=`/api/avatars/${u.id}`;
    return safe;
  }
  async function author(id) { const u = (await db.prepare('SELECT id,name,username,avatar,account_status FROM users WHERE id=?').get(id)); return u ? studentProfile(u) : {id, name:'Utilisateur', username:'', avatar:'', role:'student'}; }
  async function isChatBlocked(u) {if(u?.role==='global_admin')return false;return !!(u?.faculty_id&&await db.prepare('SELECT 1 FROM chat_bans WHERE user_id=? AND faculty_id=?').get(u.id,u.faculty_id));}
  async function selfUser(u) {return publicUser({...u,chat_blocked:await isChatBlocked(u)});}
  function requireUser(req, _res, next) { if (!req.user) return next(problem(401, 'Connectez-vous pour accéder à votre communauté.'));if(req.user.account_status!=='approved')return next(admissionProblem(req.user));next(); }
  function requireFaculty(req, _res, next) {
    if (!req.user) return next(problem(401, 'Connectez-vous pour accéder à votre communauté.'));
    if(req.user.account_status!=='approved')return next(admissionProblem(req.user));
    if (!req.user.faculty_id) return next(problem(403, 'Choisissez votre faculté avant de continuer.'));
    const asked = req.query.faculty_id || req.query.faculty;
    if (asked && asked !== req.user.faculty_id) return next(problem(403, 'Cet espace appartient à une autre faculté.'));
    next();
  }
  function role(...roles) { return (req, _res, next) => roles.includes(req.user.role) ? next() : next(problem(403, 'Vous n’avez pas l’autorisation d’effectuer cette action.')); }
  function requireChat(req,_res,next) {if(req.user.chat_blocked)return next(problem(403,'Votre accès aux discussions est temporairement bloqué. Vos ressources et votre compte restent accessibles.'));next();}
  function hasStudies(user) { return filiereBelongsToFaculty(user.faculty_id,user.filiere_id); }
  function semesterValue(value) {
    const semester=Number(String(value ?? '').replace(/^s/i,''));
    if(!Number.isInteger(semester)||semester<1||semester>6)throw problem(400,'Choisissez un semestre de S1 à S6.');
    return semester;
  }
  function chatScope(req,channel,semesterKey='semester') {
    if(channel!=='filiere')return {filiere_id:null,semester:null};
    if(!hasStudies(req.user))throw problem(403,'Choisissez votre filière avant d’accéder aux chats.');
    const asked=req.body.filiere_id;
    if(semesterKey==='semester'&&asked!==undefined&&asked!==req.user.filiere_id)throw problem(403,'Ce chat appartient à une autre filière.');
    return {filiere_id:req.user.filiere_id,semester:getChatSemester(semesterValue(req.body[semesterKey]))};
  }
  function canReadMessage(item,user) {
    return item && !item.removed && !user.chat_blocked && item.faculty_id===user.faculty_id && (item.channel!=='filiere'||hasStudies(user)&&item.filiere_id===user.filiere_id&&Number.isInteger(item.semester)&&item.semester>=1&&item.semester<=6);
  }
  async function canReadAnnouncement(item,user) {
    if(!item||item.faculty_id!==user.faculty_id)return false;
    if(!item.message_id)return true;
    return canReadMessage((await db.prepare('SELECT * FROM messages WHERE id=?').get(item.message_id)),user);
  }
  async function canReadItem(table,item,user) {
    if(table==='messages')return canReadMessage(item,user);
    if(table==='announcements')return (await canReadAnnouncement(item,user));
    if(table==='resources')return item&&!item.removed&&item.faculty_id===user.faculty_id&&!!user.filiere_id&&item.filiere_id===user.filiere_id;
    return item&&!item.removed&&item.faculty_id===user.faculty_id;
  }
  async function canReadNotification(item,user) {
    const linkedAnnouncement=String(item.path).match(/#announcement-(\d+)/);
    if(linkedAnnouncement)return (await canReadAnnouncement((await db.prepare('SELECT * FROM announcements WHERE id=?').get(Number(linkedAnnouncement[1]))),user));
    const linkedMessage=String(item.path).match(/#message-(\d+)/);
    if(linkedMessage)return canReadMessage((await db.prepare('SELECT * FROM messages WHERE id=?').get(Number(linkedMessage[1]))),user);
    const linkedResource=String(item.path).match(/#resource-(\d+)/);
    if(linkedResource)return canReadItem('resources',await db.prepare('SELECT * FROM resources WHERE id=?').get(Number(linkedResource[1])),user);
    return true;
  }
  async function scoped(table, id, req, moderation=false) {
    const item = (await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(asId(id)));
    if (!item || item.removed) throw problem(404, 'Élément introuvable.');
    if (item.faculty_id !== req.user.faculty_id) throw problem(403, 'Cet élément appartient à une autre faculté.');
    if(!moderation&&!(await canReadItem(table,item,req.user)))throw problem(403,'Cet élément appartient à une autre filière.');
    return item;
  }
  async function message(m, viewerId) {
    return (await messagesFor([m],viewerId))[0];
  }
  async function messagesFor(rows,viewerId) {
    if(!rows.length)return [];
    const ids=rows.map(m=>m.id),authorIds=[...new Set(rows.map(m=>m.author_id).filter(Boolean))];
    const [authors,reactions,mine]=await Promise.all([
      db.prepare('SELECT id,name,username,avatar,role,account_status FROM users WHERE id=ANY(?)').all(authorIds),
      db.prepare('SELECT message_id,reaction,COUNT(*) AS n FROM reactions WHERE message_id=ANY(?) GROUP BY message_id,reaction').all(ids),
      db.prepare('SELECT message_id,reaction FROM reactions WHERE message_id=ANY(?) AND user_id=?').all(ids,viewerId),
    ]);
    const authorsById=new Map(authors.map(u=>[u.id,studentProfile(u)]));
    return rows.map(m=>({...m,semester:m.channel==='filiere'?getChatSemester(m.semester):m.semester,author:authorsById.get(m.author_id)||{id:m.author_id,name:'Utilisateur',username:'',avatar:'',role:'student'},pinned:!!m.pinned,reactions:{like:0,heart:0,...Object.fromEntries(reactions.filter(r=>r.message_id===m.id).map(r=>[r.reaction,r.n]))},my_reactions:mine.filter(r=>r.message_id===m.id).map(r=>r.reaction),author_id:undefined,removed:undefined}));
  }
  async function resource(r,viewer) {
    return (await resourcesFor([r],viewer))[0];
  }
  async function resourcesFor(rows,viewer) {
    if(!rows.length)return [];
    const ids=rows.map(r=>r.id),sourceIds=[...new Set(rows.map(r=>r.message_id).filter(Boolean))];
    const [sources,versions]=await Promise.all([
      db.prepare('SELECT * FROM messages WHERE id=ANY(?)').all(sourceIds),
      db.prepare('SELECT resource_id,version,filename,updated_at,editor_id FROM resource_versions WHERE resource_id=ANY(?) ORDER BY version DESC').all(ids),
    ]);
    const authorIds=[...new Set([...rows.map(r=>r.author_id),...versions.map(v=>v.editor_id)].filter(Boolean))];
    const authors=await db.prepare('SELECT id,name,username,avatar,role,account_status FROM users WHERE id=ANY(?)').all(authorIds);
    const authorsById=new Map(authors.map(u=>[u.id,studentProfile(u)])),sourcesById=new Map(sources.map(m=>[m.id,m]));
    const user=id=>authorsById.get(id)||{id,name:'Utilisateur',username:'',avatar:'',role:'student'};
    return rows.map(r=>{
      const {stored_name,object_key,sha256,author_id,removed,...safe}=r;
      const source=sourcesById.get(safe.message_id);
      if(viewer&&safe.message_id&&!canReadMessage(source,viewer))safe.message_id=null;
      safe.chat_semester=safe.message_id&&source?.channel==='filiere'?getChatSemester(source.semester):null;
      return {...safe,author:user(author_id),versions:versions.filter(v=>v.resource_id===r.id).map(({resource_id,editor_id,...v})=>({...v,created_at:v.updated_at,author:user(editor_id)}))};
    });
  }
  async function announcement(a) { const {author_id, ...safe} = a;const source=a.message_id?(await db.prepare('SELECT * FROM messages WHERE id=?').get(a.message_id)):null;return {...safe, semester:source?.channel==='filiere'?getChatSemester(source.semester):source?.semester??null, filiere_id:source?.filiere_id??null, author:(await author(author_id)), pinned:!!a.pinned}; }
  async function broadcast(faculty,filiereId=null) {
    if(!clients.size)return;
    const recipientIds=[...clients.keys()];
    const users=await db.prepare('SELECT u.id,u.role,u.faculty_id,u.filiere_id,u.disabled,u.account_status,u.session_version,b.user_id AS chat_banned FROM users u LEFT JOIN chat_bans b ON b.user_id=u.id AND b.faculty_id=u.faculty_id WHERE u.id=ANY(?)').all(recipientIds);
    const byId=new Map(users.map(u=>[u.id,u]));
    for (const id of recipientIds) {
      const streams=clients.get(id)||[];
      const user = byId.get(id);
      const blocked=!!user?.chat_banned&&user.role!=='global_admin';
      for (const res of streams) {
        if (!user || user.disabled || user.account_status!=='approved' || blocked || user.session_version!==res.sessionVersion) {res.end();continue;}
        if (user?.disabled || user?.faculty_id !== faculty) continue;
        if(filiereId&&user?.filiere_id!==filiereId)continue;
        res.write('event: update\ndata: {}\n\n');
      }
    }
  }
  async function notify(faculty, type, title, body, path, exclude = null,filiereId=null) {
    const users=await db.prepare("SELECT id,filiere_id,preferences FROM users WHERE faculty_id=? AND disabled=0 AND account_status='approved'").all(faculty);
    const recipients=users.filter(u=>u.id!==exclude&&JSON.parse(u.preferences)[type]!==false&&(!filiereId||u.filiere_id===filiereId));
    // Bound batches avoid a cloud round trip per student while remaining below
    // PostgreSQL's parameter limit. Existing transactions keep publication atomic.
    for(let start=0;start<recipients.length;start+=500){
      const batch=recipients.slice(start,start+500);
      const values=batch.flatMap(u=>[u.id,faculty,type,title,body.slice(0,240),path,now()]);
      await db.prepare(`INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES ${batch.map(()=>'(?,?,?,?,?,?,?)').join(',')}`).run(...values);
    }
  }
  async function notifyRegistration(name) {
    const administrators=await db.prepare("SELECT id,faculty_id,preferences FROM users WHERE role='global_admin' AND disabled=0 AND account_status='approved'").all();
    const insert=db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)');
    for(const admin of administrators)if(admin.faculty_id&&JSON.parse(admin.preferences).admin!==false)await insert.run(admin.id,admin.faculty_id,'admin','Nouvelle demande d’inscription',name,'/app/admin?tab=registrations',now());
  }
  async function notifyAdminInbox(faculty,title,body,path,{reports=false}={}) {
    const localRoles=reports?['faculty_admin','moderator']:['faculty_admin'];
    const recipients=await db.prepare("SELECT id,faculty_id,preferences FROM users WHERE disabled=0 AND account_status='approved' AND (role='global_admin' OR (faculty_id=? AND role=ANY(?)))").all(faculty,localRoles);
    const insert=db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)');
    for(const recipient of recipients)if(recipient.faculty_id&&JSON.parse(recipient.preferences).admin!==false)await insert.run(recipient.id,recipient.faculty_id,'admin',title,body.slice(0,240),path,now());
    return recipients.map(recipient=>recipient.id);
  }
  async function broadcastAdminInbox(ids) {
    const connected=ids.filter(id=>clients.has(id));
    if(!connected.length)return;
    const recipients=await db.prepare("SELECT id,session_version FROM users WHERE id=ANY(?) AND role IN ('global_admin','faculty_admin','moderator') AND disabled=0 AND account_status='approved'").all(connected);
    for(const recipient of recipients)for(const stream of clients.get(recipient.id)||[])if(stream.sessionVersion===recipient.session_version)stream.write('event: update\ndata: {"adminInbox":true}\n\n');
  }
  async function broadcastRegistrations() {
    if(!clients.size)return;
    const recipients=await db.prepare("SELECT id,session_version FROM users WHERE id=ANY(?) AND role='global_admin' AND disabled=0 AND account_status='approved'").all([...clients.keys()]);
    for(const admin of recipients)for(const stream of clients.get(admin.id)||[])if(stream.sessionVersion===admin.session_version)stream.write('event: update\ndata: {"registrations":true}\n\n');
  }
  const transaction = callback => db.transaction(callback);
  async function filterReadable(items, predicate) {const allowed=await Promise.all(items.map(predicate));return items.filter((_item,index)=>allowed[index]);}
  async function moduleId(faculty,filiere,semester,name) {
    const row=await db.prepare('INSERT INTO modules (faculty_id,filiere_id,semester,name) VALUES (?,?,?,?) ON CONFLICT (faculty_id,filiere_id,semester,name) DO UPDATE SET name=excluded.name RETURNING id').get(faculty,filiere,semester,name);
    return row.id;
  }
  async function publicationFaculties(req) {
    const target=req.body.faculty_id || req.user.faculty_id;
    if(req.user.role!=='global_admin'&&target!==req.user.faculty_id)throw problem(403,'Vous ne pouvez publier que dans votre faculté.');
    if(target==='all'&&req.user.role==='global_admin')return (await db.prepare('SELECT id FROM faculties').all()).map(f=>f.id);
    if(!(await db.prepare('SELECT 1 FROM faculties WHERE id=?').get(target)))throw problem(400,'Faculté invalide.');
    return [target];
  }
  async function checkChannelWrite(req,channel){const row=(await db.prepare('SELECT read_only FROM channels WHERE id=? AND faculty_id=?').get(channel,req.user.faculty_id));if(row?.read_only&&req.user.role==='student')throw problem(403,'Cette discussion est en lecture seule. L’administration peut toujours y publier.');}
  async function removeChatMessage(m) {
    await transaction(async()=>{
      const pins=await db.prepare('SELECT id FROM announcements WHERE message_id=?').all(m.id);
      await db.prepare("DELETE FROM saved WHERE type='message' AND target_id=?").run(m.id);
      for(const pin of pins){await db.prepare("DELETE FROM saved WHERE type='announcement' AND target_id=?").run(pin.id);await db.prepare('DELETE FROM notifications WHERE path LIKE ?').run(`%#announcement-${pin.id}`);}
      await db.prepare('DELETE FROM notifications WHERE path LIKE ?').run(`%#message-${m.id}`);
      await db.prepare('DELETE FROM reactions WHERE message_id=?').run(m.id);
      await db.prepare('DELETE FROM announcements WHERE message_id=?').run(m.id);
      await db.prepare('UPDATE resources SET message_id=NULL WHERE message_id=?').run(m.id);
      await db.prepare('UPDATE messages SET reply_to=NULL WHERE reply_to=?').run(m.id);
      await db.prepare('UPDATE messages SET removed=1,pinned=0,resource_id=NULL WHERE id=?').run(m.id);
    });
    await broadcast(m.faculty_id,m.channel==='filiere'?m.filiere_id:null);
  }

  app.get('/api/health', (_req, res) => res.json({ok:true}));
  app.get('/api/session', (req, res) => res.json({user:req.user ? publicUser(req.user) : null}));
  app.get('/api/registration-options', async (_req,res)=>{
    const faculties=await db.prepare('SELECT id,code,name,arabic,icon,color FROM faculties ORDER BY id').all();
    res.json({faculties:faculties.map(f=>({...f,filieres:getFilieres(f.id)}))});
  });
  app.post('/api/register',async(req,res)=>{
    if(req.user)throw problem(409,'Déconnectez-vous avant de créer un compte.');
    const key=req.ip,previous=registrationAttempts.get(key);
    if(previous?.expires>Date.now()&&previous.count>=120)throw problem(429,'Trop de demandes d’inscription. Réessayez dans 15 minutes.');
    registrationAttempts.set(key,{count:previous?.expires>Date.now()?previous.count+1:1,expires:Date.now()+900000});
    const username=string(req.body.username,'Nom d’utilisateur',40),name=string(req.body.name,'Nom',100),email=string(req.body.email,'Adresse e-mail',160).toLowerCase(),password=passwordValue(req.body.password);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw problem(400,'Adresse e-mail invalide.');
    if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw problem(400,'Nom d’utilisateur invalide.');
    if(password.length<10)throw problem(400,'Le mot de passe doit contenir au moins 10 caractères.');
    const faculty=string(req.body.faculty_id,'Faculté',30),filiere=string(req.body.filiere_id,'Filière',80),semester=semesterValue(req.body.current_semester);
    if(!filiereBelongsToFaculty(faculty,filiere)||!await db.prepare('SELECT 1 FROM faculties WHERE id=?').get(faculty))throw problem(400,'Choisissez une filière de votre faculté.');
    if(await db.prepare('SELECT 1 FROM users WHERE LOWER(username)=LOWER(?)').get(username))throw problem(409,'Ce nom d’utilisateur est déjà utilisé.');
    if(await db.prepare('SELECT 1 FROM users WHERE LOWER(email)=LOWER(?)').get(email))throw problem(409,'Cette adresse e-mail est déjà utilisée.');
    const created=await auth.createUser(req,{email,password,name});
    let id;
    try {
      id=await transaction(async()=>{
        const inserted=Number((await db.prepare("INSERT INTO users (username,name,email,auth_user_id,role,faculty_id,filiere_id,current_semester,account_status,registered_at) VALUES (?,?,?,?,'student',?,?,?,'pending',?)").run(username,name,email,created.id,faculty,filiere,semester,now())).lastInsertRowid);
        await notifyRegistration(name);
        return inserted;
      });
    } catch(error) {
      try{await created.cleanup?.();}catch{console.error('[CampusLink Auth] Registration cleanup failed.');}
      throw error;
    }
    const profile=await db.prepare('SELECT * FROM users WHERE id=?').get(id);
    // The profile remains pending even if the provider cannot open its session.
    // The student can sign in later without submitting a duplicate application.
    let signedIn=true;
    try{await auth.signIn(req,res,{email,password,expectedAuthUserId:created.id});}
    catch{signedIn=false;auth.clearCookie?.(req,res);}
    await broadcastRegistrations();
    res.status(201).json({user:publicUser(profile),authenticated:signedIn});
  });
  app.post('/api/login', async (req, res) => {
    const username = string(req.body.username, 'Nom d’utilisateur', 160);
    const password = passwordValue(req.body.password);
    const key = req.ip;
    const attempt = attempts.get(key);
    if (attempt && attempt.expires > Date.now() && attempt.count >= 12) throw problem(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    let u;
    try {
      const profile=await db.prepare('SELECT * FROM users WHERE LOWER(username)=LOWER(?) OR LOWER(email)=LOWER(?)').get(username,username);
      if(!profile?.auth_user_id||!profile.email)throw problem(401,'Nom d’utilisateur ou mot de passe incorrect.');
      if(profile.disabled)throw problem(403,'Ce compte est désactivé.');
      const signed=await auth.signIn(req,res,{email:profile.email,password,expectedAuthUserId:profile.auth_user_id});
      u=signed.user;
    } catch(error) {
      attempts.set(key, {count:attempt?.expires > Date.now() ? attempt.count+1 : 1, expires:Date.now()+900000});
      throw error;
    }
    attempts.delete(key);
    res.json({user:await selfUser(u)});
  });
  app.post('/api/logout', async (req, res) => {
    await auth.signOut(req,res);
    for (const stream of clients.get(req.user?.id)||[])stream.end();
    res.json({ok:true});
  });
  app.get('/api/faculties', requireUser, async (req, res) => {
    if (req.user.faculty_id && req.user.role !== 'global_admin') throw problem(403, 'Votre faculté est déjà associée à votre compte.');
    res.json({faculties:(await db.prepare("SELECT f.*, (SELECT COUNT(*) FROM users u WHERE u.faculty_id=f.id AND u.disabled=0 AND u.account_status='approved') AS members FROM faculties f").all()).map(f=>({...f,online:0}))});
  });
  app.post('/api/faculty', requireUser, async (req, res) => {
    if (req.user.faculty_id) throw problem(403, 'Ce choix est définitif. Seul l’administrateur pourra modifier votre faculté.');
    if (req.body.confirmed !== true) throw problem(400, 'Confirmez votre choix définitif de faculté.');
    const faculty = (await db.prepare('SELECT * FROM faculties WHERE id=?').get(req.body.faculty_id || ''));
    if (!faculty) throw problem(400, 'Faculté invalide.');
    (await transaction(async () => {
      const current=await db.prepare('SELECT faculty_id FROM users WHERE id=? FOR UPDATE').get(req.user.id);
      if(current?.faculty_id)throw problem(403,'Ce choix est définitif. Seul l’administrateur pourra modifier votre faculté.');
      (await db.prepare('UPDATE users SET faculty_id=? WHERE id=? AND faculty_id IS NULL').run(faculty.id,req.user.id));
      const insert = db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)');
      const announcements=await filterReadable(await db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC').all(faculty.id),a=>canReadAnnouncement(a,{...req.user,faculty_id:faculty.id}));
      for (const a of announcements.slice(0,2)) await insert.run(req.user.id,faculty.id,'announcements','Annonce de votre faculté',a.content.slice(0,200),`/app/announcements#announcement-${a.id}`,a.created_at);
      for (const r of (await db.prepare("SELECT * FROM resources WHERE faculty_id=? AND category<>'general' ORDER BY created_at DESC LIMIT 2").all(faculty.id))) (await insert.run(req.user.id,faculty.id,'resources','Ressource à découvrir',r.title,resourcePath(r),r.created_at));
      const ev = (await db.prepare('SELECT * FROM events WHERE faculty_id=? AND date>=? ORDER BY date LIMIT 1').get(faculty.id,now().slice(0,10)));
      if (ev) (await insert.run(req.user.id,faculty.id,'calendar','Prochain rendez-vous',`${ev.title} · ${ev.date}`,`/app/calendar#event-${ev.id}`,now()));
    }));
    res.json({user:await selfUser((await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))});
  });

  app.get('/api/studies', requireFaculty, (req,res) => res.json({filieres:getFilieres(req.user.faculty_id),user:publicUser(req.user)}));
  app.post('/api/studies', requireFaculty, async (req,res) => {
    if('faculty_id' in req.body||'faculty' in req.body)throw problem(400,'Votre faculté est déjà connue.');
    const filiere=string(req.body.filiere_id,'Filière',80);
    if(!filiereBelongsToFaculty(req.user.faculty_id,filiere))throw problem(400,'Choisissez une filière de votre faculté.');
    const semester=semesterValue(req.body.current_semester??1);
    (await db.prepare('UPDATE users SET filiere_id=?,current_semester=? WHERE id=?').run(filiere,semester,req.user.id));
    res.json({user:await selfUser((await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))});
  });

  app.get('/api/modules',requireFaculty,async (req,res)=>{
    const filiere=String(req.query.filiere_id||req.user.filiere_id||'');
    if(!filiereBelongsToFaculty(req.user.faculty_id,filiere))throw problem(400,'Choisissez une filière de votre faculté.');
    if(req.user.role==='student'&&filiere!==req.user.filiere_id)throw problem(403,'Cette bibliothèque appartient à une autre filière.');
    const semester=semesterValue(req.query.semester);
    res.json({modules:await db.prepare('SELECT id,name,filiere_id,semester FROM modules WHERE faculty_id=? AND filiere_id=? AND semester=? ORDER BY name').all(req.user.faculty_id,filiere,semester)});
  });

  app.get('/api/bootstrap', requireFaculty, async (req, res) => {
    const faculty = (await db.prepare('SELECT * FROM faculties WHERE id=?').get(req.user.faculty_id));
    const members = (await db.prepare("SELECT id,name,username,avatar,role,faculty_id,last_seen FROM users WHERE faculty_id=? AND disabled=0 AND account_status='approved' ORDER BY name").all(faculty.id)).map(({last_seen,...u})=>({...studentProfile(u),online:u.id===req.user.id || !!(last_seen && Date.parse(last_seen)>Date.now()-300000)}));
    const chatOnline=hasStudies(req.user)?(await db.prepare("SELECT COUNT(*) AS n FROM users WHERE faculty_id=? AND filiere_id=? AND disabled=0 AND account_status='approved' AND (id=? OR last_seen>?)").get(faculty.id,req.user.filiere_id,req.user.id,new Date(Date.now()-300000).toISOString())).n:0;
    const [channels,messageRows,resourceRows,announcementRows,notificationRows,eventRows,savedRows,history]=await Promise.all([
      db.prepare('SELECT * FROM channels WHERE faculty_id=?').all(faculty.id),
      db.prepare('SELECT * FROM messages WHERE faculty_id=? AND removed=0 ORDER BY created_at,id').all(faculty.id),
      req.user.filiere_id ? db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND removed=0 ORDER BY created_at DESC,id DESC').all(faculty.id,req.user.filiere_id) : [],
      db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC,id DESC').all(faculty.id),
      db.prepare('SELECT id,type,title,body,path,created_at,read FROM notifications WHERE user_id=? AND faculty_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(req.user.id,faculty.id),
      db.prepare('SELECT id,title,date,time,type FROM events WHERE faculty_id=? ORDER BY date,time').all(faculty.id),
      db.prepare('SELECT type,target_id AS id FROM saved WHERE user_id=?').all(req.user.id),
      req.user.filiere_id ? db.prepare('SELECT h.resource_id,h.opened_at FROM history h JOIN resources r ON r.id=h.resource_id WHERE h.user_id=? AND r.faculty_id=? AND r.filiere_id=? AND r.removed=0 ORDER BY h.opened_at DESC LIMIT 20').all(req.user.id,faculty.id,req.user.filiere_id) : [],
    ]);
    const [messages,resources,announcements,notifications,saved]=await Promise.all([
      messagesFor(messageRows.filter(m=>canReadMessage(m,req.user)),req.user.id),
      resourcesFor(resourceRows,req.user),
      filterReadable(announcementRows,a=>canReadAnnouncement(a,req.user)).then(rows=>Promise.all(rows.map(announcement))),
      filterReadable(notificationRows,n=>canReadNotification(n,req.user)),
      filterReadable(savedRows,async s=>{const table={resource:'resources',message:'messages',announcement:'announcements'}[s.type];return table&&await canReadItem(table,await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(s.id),req.user);}),
    ]);
    res.json({
      user:publicUser(req.user),filieres:getFilieres(faculty.id),faculty:{...faculty,members:members.length,online:members.filter(u=>u.online).length,chat_online:chatOnline},
      channels:channels.map(c=>({...c,read_only:!!c.read_only})),messages,resources,announcements,
      notifications:notifications.map(n=>({...n,read:!!n.read})),members,events:eventRows,saved,history,
    });
  });
  app.get('/api/messages', requireFaculty, requireChat, async (req,res) => {
    const channel=req.query.channel||'general';
    if(!CHANNELS.includes(channel))throw problem(400,'Discussion invalide.');
    if(channel==='filiere'&&!hasStudies(req.user))throw problem(403,'Choisissez votre filière avant d’accéder aux chats.');
    if(channel==='filiere'&&req.query.filiere_id&&req.query.filiere_id!==req.user.filiere_id)throw problem(403,'Ce chat appartient à une autre filière.');
    const semester=channel==='filiere'?getChatSemester(semesterValue(req.query.semester)):null;
    const rows=await db.prepare('SELECT * FROM messages WHERE faculty_id=? AND channel=? AND removed=0 ORDER BY created_at,id').all(req.user.faculty_id,channel);
    res.json({messages:await messagesFor(rows.filter(m=>canReadMessage(m,req.user)&&(channel!=='filiere'||getChatSemester(m.semester)===semester)),req.user.id)});
  });
  app.get('/api/messages/:id', requireFaculty, requireChat, async (req,res) => res.json({message:(await message((await scoped('messages',req.params.id,req)),req.user.id))}));
  app.delete('/api/messages/:id', requireFaculty, requireChat, async (req,res)=>{
    const m=await scoped('messages',req.params.id,req,req.user.role==='global_admin');
    if(m.author_id!==req.user.id&&req.user.role!=='global_admin')throw problem(403,'Vous pouvez uniquement supprimer vos propres messages.');
    await removeChatMessage(m);res.json({ok:true});
  });
  app.get('/api/chat/blocks',requireFaculty,role('global_admin'),async(req,res)=>{
    const rows=await db.prepare("SELECT b.user_id,b.faculty_id,b.created_at,u.id,u.name,u.username,u.avatar FROM chat_bans b JOIN users u ON u.id=b.user_id AND u.faculty_id=b.faculty_id WHERE u.account_status='approved' ORDER BY b.created_at DESC").all();
    res.json({blocks:rows.map(({id,name,username,avatar,...b})=>({...b,user:studentProfile({id,name,username,avatar})}))});
  });
  app.post('/api/chat/blocks',requireFaculty,role('global_admin'),async(req,res)=>{
    const targetId=asId(req.body.user_id);
    const target=await transaction(async()=>{
      const user=await db.prepare("SELECT id,faculty_id,role FROM users WHERE id=? AND account_status='approved' FOR UPDATE").get(targetId);
      if(!user)throw problem(404,'Utilisateur introuvable.');
      if(user.id===req.user.id||user.role==='global_admin')throw problem(403,'Ce compte ne peut pas être bloqué dans les discussions.');
      if(!user.faculty_id)throw problem(400,'Cet étudiant n’a pas encore choisi sa faculté.');
      await db.prepare('INSERT INTO chat_bans (user_id,faculty_id,blocked_by,created_at) VALUES (?,?,?,?) ON CONFLICT (user_id,faculty_id) DO NOTHING').run(user.id,user.faculty_id,req.user.id,now());
      return user;
    });
    for(const stream of clients.get(target.id)||[]){stream.write('event: update\ndata: {}\n\n');stream.end();}
    await broadcast(target.faculty_id);res.json({user_id:target.id,faculty_id:target.faculty_id,chat_blocked:true});
  });
  app.delete('/api/chat/blocks/:id',requireFaculty,role('global_admin'),async(req,res)=>{
    const user=await db.prepare('SELECT id,faculty_id FROM users WHERE id=?').get(asId(req.params.id));
    if(!user)throw problem(404,'Utilisateur introuvable.');
    await db.prepare('DELETE FROM chat_bans WHERE user_id=? AND faculty_id=?').run(user.id,user.faculty_id);
    await broadcast(user.faculty_id);res.json({user_id:user.id,faculty_id:user.faculty_id,chat_blocked:false});
  });
  app.get('/api/events/stream', requireFaculty, requireChat, (req,res) => {
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.flushHeaders(); res.write(': connected\n\n');
    res.sessionVersion=req.user.session_version;
    if (!clients.has(req.user.id)) clients.set(req.user.id,new Set());
    clients.get(req.user.id).add(res);
    const heartbeat = setInterval(async ()=>{
      try {
        const current=await auth.authenticate(req);
        const user=current?.user||current;
        if(!user||user.disabled||user.account_status!=='approved'||await isChatBlocked(user)||user.session_version!==res.sessionVersion||user.faculty_id!==req.user.faculty_id)res.end();
        else res.write(': heartbeat\n\n');
      } catch {res.end();}
    },15000);
    heartbeats.add(heartbeat);
    req.on('close',()=>{ clearInterval(heartbeat);heartbeats.delete(heartbeat); clients.get(req.user.id)?.delete(res); if (!clients.get(req.user.id)?.size) clients.delete(req.user.id); });
  });

  app.post('/api/messages', requireFaculty, requireChat, async (req,res) => {
    const content = string(req.body.content,'Message',8000);
    const channel = req.body.channel || 'general';
    if (!CHANNELS.includes(channel)) throw problem(400,'Discussion invalide.');
    let clientId=null;
    if(req.body.client_id!==undefined){
      if(typeof req.body.client_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.client_id))throw problem(400,'Identifiant du message invalide.');
      clientId=req.body.client_id.toLowerCase();
    }
    const scope=chatScope(req,channel);
    const replyId=req.body.reply_to?asId(req.body.reply_to):null;
    const result=await transaction(async()=>{
      // The author-scoped key makes a retry after a lost response safe. Its
      // unique index also serializes simultaneous requests carrying that key.
      const row=await db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,reply_to,filiere_id,semester,client_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (author_id,client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *').get(req.user.faculty_id,channel,content,req.user.id,now(),replyId,scope.filiere_id,scope.semester,clientId);
      if(!row){
        const existing=await db.prepare('SELECT * FROM messages WHERE author_id=? AND client_id=?').get(req.user.id,clientId);
        if(!canReadMessage(existing,req.user))throw problem(409,'Ce message ne peut plus être renvoyé.');
        if(existing.content!==content||existing.channel!==channel||existing.reply_to!==replyId||existing.filiere_id!==scope.filiere_id||(channel==='filiere'?getChatSemester(existing.semester):existing.semester)!==scope.semester)throw problem(409,'Cet identifiant correspond déjà à un autre message.');
        return {row:existing,created:false};
      }
      await checkChannelWrite(req,channel);
      const reply=replyId?await scoped('messages',replyId,req):null;
      if(reply&&reply.channel!==channel)throw problem(400,'La réponse doit rester dans la discussion d’origine.');
      if(reply&&channel==='filiere'&&getChatSemester(reply.semester)!==scope.semester)throw problem(400,'La réponse doit rester dans le même groupe de semestres.');
      if(channel==='important')await notify(req.user.faculty_id,'important','Nouvelle discussion importante',content,`/app/chat/important#message-${row.id}`,req.user.id);
      return {row,created:true};
    });
    if(result.created)await broadcast(req.user.faculty_id,scope.filiere_id);
    res.status(result.created?201:200).json({message:await message(result.row,req.user.id)});
  });
  app.post('/api/messages/:id/reaction', requireFaculty, requireChat, async (req,res) => {
    const m = (await scoped('messages',req.params.id,req));
    if (!['like','heart'].includes(req.body.reaction)) throw problem(400,'Réaction invalide.');
    const exists = (await db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND reaction=?').get(m.id,req.user.id,req.body.reaction));
    if (exists) (await db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND reaction=?').run(m.id,req.user.id,req.body.reaction));
    else (await db.prepare('INSERT INTO reactions VALUES (?,?,?)').run(m.id,req.user.id,req.body.reaction));
    (await broadcast(req.user.faculty_id,m.channel==='filiere'?m.filiere_id:null));res.json({message:(await message(m,req.user.id))});
  });
  app.post('/api/messages/:id/pin', requireFaculty, requireChat, role('moderator','faculty_admin','global_admin'), async (req,res) => {
    const m = (await scoped('messages',req.params.id,req));
    const pinned = !m.pinned;
    const pinnedAnnouncement=await transaction(async ()=>{
      (await db.prepare('UPDATE messages SET pinned=? WHERE id=?').run(pinned?1:0,m.id));
      if (pinned) {
        const row=await db.prepare('INSERT INTO announcements (faculty_id,content,message_id,channel,author_id,created_at,resource_id,pinned) VALUES (?,?,?,?,?,?,?,1) RETURNING *').get(m.faculty_id,m.content,m.id,m.channel,m.author_id,m.created_at,m.resource_id);
        await notify(m.faculty_id,'announcements','Message épinglé',m.content,`/app/announcements#announcement-${row.id}`,req.user.id,m.channel==='filiere'?m.filiere_id:null);
        return row;
      }
      await db.prepare('DELETE FROM announcements WHERE message_id=?').run(m.id);
      return null;
    });
    await broadcast(m.faculty_id,m.channel==='filiere'?m.filiere_id:null);
    res.json({pinned,announcement:pinnedAnnouncement?await announcement(pinnedAnnouncement):null});
  });

  app.post('/api/uploads', requireFaculty, requireChat, upload.single('file'), async (req,res) => {
    if (!req.file?.size) throw problem(400,'Sélectionnez un fichier.');
    const category = req.body.category;
    const channel = req.body.channel || 'general';
    if (!CATEGORIES.includes(category)) throw problem(400,'Choisissez un type de ressource.');
    if (!CHANNELS.includes(channel)) throw problem(400,'Discussion invalide.');
    (await checkChannelWrite(req,channel));
    const filiere=string(req.body.filiere_id,'Filière',80);
    if(!filiereBelongsToFaculty(req.user.faculty_id,filiere))throw problem(400,'Choisissez une filière de votre faculté.');
    if(req.user.role==='student'&&filiere!==req.user.filiere_id)throw problem(403,'Vous pouvez publier uniquement dans la bibliothèque de votre filière.');
    const semester = semesterValue(req.body.semester);
    const scope=chatScope(req,channel,'chat_semester');
    const resourceType=string(req.body.resource_type,'Type de ressource',40).toLowerCase();
    if(!RESOURCE_TYPES.includes(resourceType))throw problem(400,'Choisissez un type de ressource.');
    const partNumber=Number(req.body.part_number);
    if(!Number.isInteger(partNumber)||partNumber<1||partNumber>999)throw problem(400,'Choisissez une partie entre 1 et 999.');
    const teacherName=string(req.body.teacher_name,'Professeur / auteur',120);
    const {filename,relativePath}=uploadFilePath(req.file.originalname,req.body.relative_path);
    const title = string(req.body.title,'Titre',180);
    const module = string(req.body.module,'Module',120);
    const content = string(req.body.content || `Je partage « ${title} ».`,'Message',8000);
    const mime = detectFile(req.file.buffer,filename);
    const hash = digest(req.file.buffer);
    const duplicate = (await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND sha256=? AND removed=0').get(req.user.faculty_id,filiere,hash));
    if (duplicate) return res.status(409).json({error:'Un fichier identique existe déjà dans les ressources de votre faculté.',resource:(await resource(duplicate,req.user))});
    const reply = req.body.reply_to ? (await scoped('messages',req.body.reply_to,req)) : null;
    if (reply && reply.channel!==channel) throw problem(400,'La réponse doit rester dans la discussion d’origine.');
    if(reply&&channel==='filiere'&&getChatSemester(reply.semester)!==scope.semester)throw problem(400,'La réponse doit rester dans le même groupe de semestres.');
    let id,objectKey,uploaded=false;
    try {
      (await transaction(async ()=>{
        const selectedModule=await moduleId(req.user.faculty_id,filiere,semester,module);
        objectKey=resourceObjectKey({filiereId:filiere,semester,moduleId:selectedModule,filename});
        uploaded=true;
        await storage.put(objectKey,req.file.buffer,mime);
        const created = now();
        const messageId = Number((await db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,reply_to,filiere_id,semester) VALUES (?,?,?,?,?,?,?,?)').run(req.user.faculty_id,channel,content,req.user.id,created,reply?.id||null,scope.filiere_id,scope.semester)).lastInsertRowid);
        id = Number((await db.prepare('INSERT INTO resources (faculty_id,title,filename,object_key,sha256,category,semester,module,module_id,author_id,created_at,size,mime,message_id,channel,filiere_id,resource_type,relative_path,part_number,teacher_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.faculty_id,title,filename,objectKey,hash,category,semester,module,selectedModule,req.user.id,created,req.file.size,mime,messageId,channel,filiere,resourceType,relativePath,partNumber,teacherName)).lastInsertRowid);
        (await db.prepare('UPDATE messages SET resource_id=? WHERE id=?').run(id,messageId));
        if (category!=='general') (await notify(req.user.faculty_id,'resources','Nouvelle ressource',`${title}${semester ? ` · S${semester}` : ''}`,resourcePath({id,category,semester,module}),req.user.id,filiere));
        if (channel==='important') (await notify(req.user.faculty_id,'important','Nouvelle discussion importante',content,`/app/chat/important#message-${messageId}`,req.user.id));
      }));
    } catch(e) {
      if(uploaded)try {await storage.delete(objectKey);}catch {console.error('[CampusLink storage] Upload cleanup failed.');}
      if(e.code==='23505') {
        const concurrent=await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND sha256=? AND removed=0').get(req.user.faculty_id,filiere,hash);
        if(concurrent)return res.status(409).json({error:'Un fichier identique existe déjà dans les ressources de votre faculté.',resource:await resource(concurrent,req.user)});
      }
      throw e;
    }
    (await broadcast(req.user.faculty_id));
    const r = (await db.prepare('SELECT * FROM resources WHERE id=?').get(id));
    res.status(201).json({resource:(await resource(r,req.user)),message:(await message((await db.prepare('SELECT * FROM messages WHERE id=?').get(r.message_id)),req.user.id))});
  });
  app.get('/api/files/:id', requireFaculty, async (req,res,next) => {
    const r = (await scoped('resources',req.params.id,req));
    if(!r.object_key)throw problem(404,'Fichier indisponible. Signalez-le à l’administration.');
    const range=req.get('range');
    if(range&&(!/^bytes=\d*-\d*$/.test(range)||range==='bytes=-'))throw problem(416,'Plage de fichier invalide.');
    const file=await storage.get(r.object_key,{range});
    const download = req.query.download==='1';
    (await db.prepare(`UPDATE resources SET ${download?'downloads':'views'}=${download?'downloads':'views'}+1 WHERE id=?`).run(r.id));
    (await db.prepare('INSERT INTO history (user_id,resource_id,opened_at) VALUES (?,?,?) ON CONFLICT(user_id,resource_id) DO UPDATE SET opened_at=excluded.opened_at').run(req.user.id,r.id,now()));
    res.type(r.mime);
    res.set('Content-Disposition',`${download?'attachment':'inline'}; filename="${r.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
    res.set('Content-Security-Policy',"sandbox; default-src 'none'");
    res.set('Cache-Control','private, no-store');
    res.set('Accept-Ranges','bytes');
    if(file.contentLength!==undefined)res.set('Content-Length',String(file.contentLength));
    if(file.etag)res.set('ETag',file.etag);
    if(file.contentRange){res.status(206);res.set('Content-Range',file.contentRange);}
    await pipeline(file.body,res);
  });

  app.post('/api/saved', requireFaculty, async (req,res) => {
    const table = {resource:'resources',message:'messages',announcement:'announcements'}[req.body.type];
    if (!table) throw problem(400,'Type invalide.');
    const target = (await scoped(table,req.body.id,req));
    const existing = (await db.prepare('SELECT 1 FROM saved WHERE user_id=? AND type=? AND target_id=?').get(req.user.id,req.body.type,target.id));
    if (existing) (await db.prepare('DELETE FROM saved WHERE user_id=? AND type=? AND target_id=?').run(req.user.id,req.body.type,target.id));
    else (await db.prepare('INSERT INTO saved VALUES (?,?,?)').run(req.user.id,req.body.type,target.id));
    res.json({saved:!existing});
  });
  app.post('/api/notifications/read', requireFaculty, async (req,res) => {
    if (req.body.ids !== undefined) {
      if (!Array.isArray(req.body.ids) || req.body.ids.length>200) throw problem(400,'Liste invalide.');
      const statement = db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=? AND faculty_id=?');
      const ids=req.body.ids.map(asId);
      await transaction(async()=>{for(const id of ids)await statement.run(id,req.user.id,req.user.faculty_id);});
    } else (await db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND faculty_id=?').run(req.user.id,req.user.faculty_id));
    res.json({ok:true});
  });
  app.post('/api/reports', requireFaculty, async (req,res) => {
    const table = {resource:'resources',message:'messages',announcement:'announcements'}[req.body.target_type];
    if (!table) throw problem(400,'Élément à signaler invalide.');
    const target = (await scoped(table,req.body.target_id,req));
    const reason = string(req.body.reason,'Motif',150);
    const details = string(req.body.details||'','Détails',2000,false);
    const {id,recipients}=await transaction(async()=>{
      const id=Number((await db.prepare('INSERT INTO reports (faculty_id,reporter_id,target_type,target_id,reason,details,created_at) VALUES (?,?,?,?,?,?,?)').run(req.user.faculty_id,req.user.id,req.body.target_type,target.id,reason,details,now())).lastInsertRowid);
      const recipients=await notifyAdminInbox(req.user.faculty_id,'Nouveau signalement',reason,'/app/admin?tab=reports',{reports:true});
      return {id,recipients};
    });
    await broadcast(req.user.faculty_id);await broadcastAdminInbox(recipients);res.status(201).json({id});
  });
  app.post('/api/contact', async (req,res) => {
    const key=req.ip, attempt=contactAttempts.get(key);
    if(attempt && attempt.expires>Date.now() && attempt.count>=8) throw problem(429,'Trop de demandes. Réessayez dans une heure.');
    const name=string(req.body.name||req.user?.name||'','Nom',100,!req.user);
    const email=string(req.body.email||'','Adresse e-mail',160,!req.user);
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem(400,'Adresse e-mail invalide.');
    const subject=string(req.body.subject,'Objet',160), content=string(req.body.message,'Message',4000);
    const {id,recipients}=await transaction(async()=>{
      const faculty=req.user?.faculty_id||null;
      const id=Number((await db.prepare('INSERT INTO contacts (faculty_id,user_id,name,email,subject,message,created_at) VALUES (?,?,?,?,?,?,?)').run(faculty,req.user?.id||null,name,email,subject,content,now())).lastInsertRowid);
      const recipients=await notifyAdminInbox(faculty,'Nouvelle demande de contact',name||req.user?.name||subject,'/app/admin?tab=contacts');
      return {id,recipients};
    });
    contactAttempts.set(key,{count:attempt?.expires>Date.now()?attempt.count+1:1,expires:Date.now()+3600000});
    await broadcastAdminInbox(recipients);
    res.status(201).json({id,ok:true});
  });

  app.patch('/api/profile', requireUser, async (req,res) => {
    if ('faculty_id' in req.body || 'faculty' in req.body || 'role' in req.body || 'disabled' in req.body) throw problem(403,'Seul l’administrateur peut modifier votre identité universitaire.');
    const values={};
    let avatarFile=null,avatarKey,avatarUploaded=false;
    if(req.body.username!==undefined){const username=string(req.body.username,'Nom d’utilisateur',40);if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw problem(400,'Utilisez 3 à 40 lettres, chiffres, points, tirets ou underscores.');if((await db.prepare('SELECT id FROM users WHERE LOWER(username)=LOWER(?) AND id<>?').get(username,req.user.id)))throw problem(409,'Ce nom d’utilisateur est déjà utilisé.');values.username=username;}
    if(req.body.language!==undefined){if(!['fr','ar','en'].includes(req.body.language))throw problem(400,'Langue invalide.');values.language=req.body.language;}
    if(req.body.avatar!==undefined){
      const avatar=req.body.avatar;
      if(avatar===''){values.avatar='';values.avatar_object_key=null;}
      else {
        if(typeof avatar!=='string'||avatar.length>1400000)throw problem(400,'Image trop volumineuse (1 Mo maximum).');
        const match=avatar.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
        if(!match)throw problem(400,'Utilisez une image PNG, JPG, WebP ou GIF.');
        const b=Buffer.from(match[2],'base64');if(b.length>1024*1024)throw problem(400,'Image trop volumineuse (1 Mo maximum).');
        const extension=match[1]==='jpeg'?'jpg':match[1];
        const mime=detectFile(b,`avatar.${extension}`);
        avatarFile={buffer:b,mime,extension};
      }
    }
    if(req.body.preferences!==undefined){if(!req.body.preferences||typeof req.body.preferences!=='object'||Array.isArray(req.body.preferences))throw problem(400,'Préférences invalides.');const prefs=JSON.parse(req.user.preferences);for(const [key,value] of Object.entries(req.body.preferences)){if(!PREF_KEYS.includes(key)||typeof value!=='boolean')throw problem(400,'Préférences invalides.');prefs[key]=value;}values.preferences=JSON.stringify(prefs);}
    const changingPassword=req.body.password!==undefined;
    if(changingPassword){const password=passwordValue(req.body.password,'Nouveau mot de passe');if(password.length<10)throw problem(400,'Le mot de passe doit contenir au moins 10 caractères.');await auth.changePassword(req,res,{currentPassword:passwordValue(req.body.current_password,'Mot de passe actuel'),newPassword:password});}
    try {
      if(avatarFile){
        avatarKey=`avatars/${req.user.id}/${randomUUID()}.${avatarFile.extension}`;
        avatarUploaded=true;
        await storage.put(avatarKey,avatarFile.buffer,avatarFile.mime);
        values.avatar=`/api/avatars/${req.user.id}`;values.avatar_object_key=avatarKey;
      }
      await transaction(async()=>{for(const [key,value] of Object.entries(values))await db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(value,req.user.id);});
    } catch(error) {
      if(avatarUploaded)try{await storage.delete(avatarKey);}catch{console.error('[CampusLink storage] Avatar cleanup failed.');}
      throw error;
    }
    if(req.body.avatar!==undefined&&req.user.avatar_object_key&&req.user.avatar_object_key!==avatarKey)try{await storage.delete(req.user.avatar_object_key);}catch{console.error('[CampusLink storage] Previous avatar cleanup failed.');}
    if(changingPassword)for(const stream of clients.get(req.user.id)||[])stream.end();
    res.json({user:await selfUser((await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))});
  });

  app.get('/api/avatars/:id',requireUser,async (req,res)=>{
    const user=await db.prepare('SELECT id,faculty_id,role,avatar,avatar_object_key,account_status FROM users WHERE id=?').get(asId(req.params.id));
    if(!user||user.account_status!=='approved')throw problem(404,'Image introuvable.');
    if(user.id!==req.user.id&&req.user.role!=='global_admin'&&(!req.user.faculty_id||user.faculty_id!==req.user.faculty_id)){
      const linked=await db.prepare('SELECT 1 FROM resources WHERE faculty_id=? AND author_id=? AND removed=0 UNION SELECT 1 FROM messages WHERE faculty_id=? AND author_id=? AND removed=0 UNION SELECT 1 FROM announcements WHERE faculty_id=? AND author_id=? LIMIT 1').get(req.user.faculty_id,user.id,req.user.faculty_id,user.id,req.user.faculty_id,user.id);
      if(!linked)throw problem(403,'Cet élément appartient à une autre faculté.');
    }
    if(!user.avatar_object_key){
      if(!/^\/avatars\/[a-z0-9_-]+\.(jpg|png|webp)$/.test(user.avatar||''))throw problem(404,'Image introuvable.');
      const path=resolve('public','.'+user.avatar);
      if(!existsSync(path))throw problem(404,'Image introuvable.');
      return res.sendFile(path);
    }
    const file=await storage.get(user.avatar_object_key);
    res.type(file.contentType||'application/octet-stream');
    res.set('Cache-Control','private, no-store');
    if(file.contentLength!==undefined)res.set('Content-Length',String(file.contentLength));
    res.set('Content-Security-Policy',"sandbox; default-src 'none'");
    await pipeline(file.body,res);
  });

  app.get('/api/search', requireFaculty, async (req,res) => {
    const q=String(req.query.q||'').trim().toLocaleLowerCase().slice(0,180);
    const type=String(req.query.type||'');
    if(req.user.chat_blocked&&type==='message')throw problem(403,'Votre accès aux discussions est temporairement bloqué.');
    if(type&&!['message','announcement','member','resource',...CATEGORIES].includes(type))throw problem(400,'Type de recherche invalide.');
    const semester=req.query.semester?Number(String(req.query.semester).replace(/^s/i,'')):null;
    if(req.query.semester && (!Number.isInteger(semester)||semester<1||semester>6))throw problem(400,'Semestre invalide.');
    const module=String(req.query.module||'').toLocaleLowerCase();
    const authorFilter=String(req.query.author||'');
    const date=String(req.query.date||'');
    if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw problem(400,'Date invalide.');
    const results=[];
    const matches=(text)=>!q||text.toLocaleLowerCase().includes(q);
    const baseMatches=async (row)=>{const a=(await author(row.author_id||row.id));return (!authorFilter||String(a.id)===authorFilter||a.username===authorFilter)&&(!date||String(row.created_at||'').startsWith(date));};
    if(!type||type==='resource'||CATEGORIES.includes(type))for(const r of (req.user.filiere_id ? await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND removed=0 ORDER BY created_at DESC').all(req.user.faculty_id,req.user.filiere_id) : [])){
      if(type&&type!=='resource'&&r.category!==type)continue;
      if(semester&&r.semester!==semester||module&&r.module.toLocaleLowerCase()!==module||!await baseMatches(r)||!matches(`${r.title} ${r.filename} ${r.module} ${r.teacher_name||''} ${r.part_number||''}`))continue;
      results.push({id:r.id,type:r.category,title:r.title,context:`${r.filename} · ${r.module}${r.semester?` · S${r.semester}`:''}`,path:resourcePath(r),author:(await author(r.author_id)),semester:r.semester,module:r.module,date:r.created_at});
    }
    if((!type||type==='message')&&!module)for(const m of (await db.prepare('SELECT * FROM messages WHERE faculty_id=? AND removed=0 ORDER BY created_at DESC').all(req.user.faculty_id)))if(canReadMessage(m,req.user)&&(!semester||m.channel==='filiere'&&getChatSemester(m.semester)===getChatSemester(semester))&&matches(m.content)&&await baseMatches(m))results.push({id:m.id,type:'message',title:m.content.slice(0,100),context:`#${m.channel}${m.channel==='filiere'?` · ${getChatSemesterLabel(m.semester)}`:''} · ${(await author(m.author_id)).name}`,path:messagePath(m),author:(await author(m.author_id)),semester:m.channel==='filiere'?getChatSemester(m.semester):m.semester,filiere_id:m.filiere_id,date:m.created_at});
    if((!type||type==='announcement')&&!semester&&!module)for(const a of (await db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC').all(req.user.faculty_id)))if((await canReadAnnouncement(a,req.user))&&matches(a.content)&&await baseMatches(a))results.push({id:a.id,type:'announcement',title:a.content.slice(0,100),context:(await author(a.author_id)).name,path:`/app/announcements#announcement-${a.id}`,author:(await author(a.author_id)),date:a.created_at});
    if((!type||type==='member')&&!semester&&!module&&!date)for(const raw of (await db.prepare("SELECT id,name,username,avatar,role FROM users WHERE faculty_id=? AND disabled=0 AND account_status='approved' ORDER BY name").all(req.user.faculty_id))){const u=studentProfile(raw);if(matches(`${u.name} ${u.username}`)&&(!authorFilter||String(u.id)===authorFilter||u.username===authorFilter))results.push({id:u.id,type:'member',title:u.name,context:`@${u.username}`,path:`/app/members#member-${u.id}`,author:u});}
    res.json({results:results.slice(0,100)});
  });

  app.get('/api/admin', requireFaculty, role('moderator','faculty_admin','global_admin'), async (req,res) => {
    const global=req.user.role==='global_admin';
    const where=global?'':' WHERE faculty_id=?';
    const args=global?[]:[req.user.faculty_id];
    const reports=await db.prepare(`SELECT * FROM reports${where} ORDER BY created_at DESC`).all(...args);
    const resources=req.user.role==='moderator'?[]:await db.prepare(`SELECT * FROM resources${where}${global?' WHERE':' AND'} removed=0 ORDER BY created_at DESC`).all(...args);
    res.json({
      users:req.user.role==='moderator'?[]:await Promise.all((await db.prepare(`SELECT * FROM users${where}${global?' WHERE':' AND'} account_status${global?"<>'deleted'":"='approved'"} ORDER BY name`).all(...args)).map(selfUser)),
      reports:await Promise.all(reports.map(async r=>({...r,reporter:await author(r.reporter_id)}))),
      contacts:req.user.role==='moderator'?[]:(await db.prepare(`SELECT * FROM contacts${where} ORDER BY created_at DESC`).all(...args)),
      faculties:global?(await db.prepare("SELECT f.*, (SELECT COUNT(*) FROM users u WHERE u.faculty_id=f.id AND u.disabled=0 AND u.account_status='approved') AS members FROM faculties f").all()):[],
      channels:req.user.role==='moderator'?[]:(await db.prepare(`SELECT * FROM channels${where} ORDER BY faculty_id,id`).all(...args)).map(c=>({...c,read_only:!!c.read_only})),
      resources:await resourcesFor(resources),
    });
  });
  app.get('/api/admin/registrations',requireFaculty,role('global_admin'),async(req,res)=>{
    const rows=await db.prepare("SELECT * FROM users WHERE role='student' AND account_status IN ('pending','rejected') ORDER BY registered_at DESC,id DESC").all();
    res.json({requests:rows.map(publicUser)});
  });
  app.patch('/api/admin/users/:id/admission',requireFaculty,role('global_admin'),async(req,res)=>{
    const status=req.body.status;
    if(!['approved','rejected'].includes(status))throw problem(400,'Choisissez de valider ou de refuser cette inscription.');
    const target=await transaction(async()=>{
      const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(asId(req.params.id));
      if(!user||user.account_status==='deleted')throw problem(404,'Utilisateur introuvable.');
      if(user.id===req.user.id||user.role!=='student')throw problem(403,'Ce compte n’est pas une demande d’inscription étudiante.');
      if(user.account_status===status)return user;
      if(user.account_status==='approved')throw problem(409,'Cet étudiant est déjà accepté.');
      if(status==='approved'&&(!hasStudies(user)||!user.faculty_id))throw problem(400,'La faculté et la filière de cette demande sont invalides.');
      const updated=await db.prepare('UPDATE users SET account_status=?,reviewed_at=?,reviewed_by=? WHERE id=? RETURNING *').get(status,now(),req.user.id,user.id);
      if(status==='approved'&&JSON.parse(user.preferences).admin!==false)await db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)').run(user.id,user.faculty_id,'admin','Inscription acceptée','Votre compte est prêt. Bienvenue dans votre communauté !','/app',now());
      return updated;
    });
    for(const stream of clients.get(target.id)||[])stream.end();
    await broadcastRegistrations();
    await broadcast(target.faculty_id);
    res.json({user:await selfUser(target)});
  });
  app.delete('/api/admin/users/:id',requireFaculty,role('global_admin'),async(req,res)=>{
    const target=await transaction(async()=>{
      const user=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(asId(req.params.id));
      if(!user||user.account_status==='deleted')throw problem(404,'Utilisateur introuvable.');
      if(user.id===req.user.id||user.role!=='student')throw problem(403,'Vous pouvez uniquement supprimer un compte étudiant.');
      // Keep this anonymous row because messages and academic files reference it.
      // Revocation and unlinking commit together before any provider round trip.
      await db.prepare("UPDATE users SET account_status='deleted',disabled=1,auth_revoked_at=?,session_version=session_version+1,auth_user_id=NULL,email=NULL,username=?,name='Étudiant supprimé',avatar='',avatar_object_key=NULL,faculty_id=NULL,filiere_id=NULL,last_seen=NULL,legacy_password_hash=NULL,reviewed_at=?,reviewed_by=? WHERE id=?").run(now(),`deleted-${user.id}-${randomUUID()}`,now(),req.user.id,user.id);
      for(const table of ['notifications','saved','history','reactions','chat_bans'])await db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(user.id);
      await db.prepare("UPDATE contacts SET name='Étudiant supprimé',email=NULL WHERE user_id=?").run(user.id);
      return user;
    });
    for(const stream of clients.get(target.id)||[]){stream.write('event: update\ndata: {}\n\n');stream.end();}
    if(target.auth_user_id)try{await auth.revokeUserSessions(req,target.auth_user_id);}catch{console.error('[CampusLink Auth] Deleted profile is locally revoked; provider session cleanup failed.');}
    if(target.avatar_object_key)try{await storage.delete(target.avatar_object_key);}catch{console.error('[CampusLink storage] Deleted profile avatar cleanup failed.');}
    await broadcast(target.faculty_id);
    await broadcastRegistrations();
    res.json({ok:true});
  });
  app.post('/api/admin/users', requireFaculty, role('global_admin'), async (req,res) => {
    const username=string(req.body.username,'Nom d’utilisateur',40),name=string(req.body.name,'Nom',100),password=passwordValue(req.body.password);
    const email=string(req.body.email,'Adresse e-mail',160).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw problem(400,'Adresse e-mail invalide.');
    if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw problem(400,'Nom d’utilisateur invalide.');
    if(password.length<10)throw problem(400,'Le mot de passe doit contenir au moins 10 caractères.');
    const roleValue=req.body.role||'student',faculty=req.body.faculty_id||null;
    if(!ROLES.includes(roleValue))throw problem(400,'Rôle invalide.');
    if(roleValue!=='student'&&!faculty)throw problem(400,'Attribuez une faculté à ce rôle.');
    if(faculty&&!(await db.prepare('SELECT 1 FROM faculties WHERE id=?').get(faculty)))throw problem(400,'Faculté invalide.');
    if((await db.prepare('SELECT 1 FROM users WHERE LOWER(username)=LOWER(?)').get(username)))throw problem(409,'Ce nom d’utilisateur est déjà utilisé.');
    if((await db.prepare('SELECT 1 FROM users WHERE LOWER(email)=LOWER(?)').get(email)))throw problem(409,'Cette adresse e-mail est déjà utilisée.');
    const created=await auth.createUser(req,{email,password,name});
    let id;
    try {id=Number((await db.prepare('INSERT INTO users (username,name,email,auth_user_id,role,faculty_id) VALUES (?,?,?,?,?,?)').run(username,name,email,created.id,roleValue,faculty)).lastInsertRowid);}
    catch(error){try{await created.cleanup?.();}catch{console.error('[CampusLink Auth] Account cleanup failed.');}throw error;}
    res.status(201).json({user:publicUser((await db.prepare('SELECT * FROM users WHERE id=?').get(id)))});
  });
  app.patch('/api/admin/channels/:id', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    if(!CHANNELS.includes(req.params.id))throw problem(400,'Discussion invalide.');
    const faculty=req.body.faculty_id||req.user.faculty_id;
    if(req.user.role!=='global_admin'&&faculty!==req.user.faculty_id)throw problem(403,'Vous ne pouvez gérer que les discussions de votre faculté.');
    const channel=(await db.prepare('SELECT * FROM channels WHERE id=? AND faculty_id=?').get(req.params.id,faculty));
    if(!channel)throw problem(404,'Discussion introuvable.');
    const values={};
    if(req.body.name!==undefined)values.name=string(req.body.name,'Nom de la discussion',80);
    if(req.body.description!==undefined)values.description=string(req.body.description,'Description',500,false);
    if(req.body.read_only!==undefined){if(typeof req.body.read_only!=='boolean')throw problem(400,'État de la discussion invalide.');values.read_only=req.body.read_only?1:0;}
    for(const [key,value]of Object.entries(values))(await db.prepare(`UPDATE channels SET ${key}=? WHERE id=? AND faculty_id=?`).run(value,channel.id,faculty));
    (await broadcast(faculty));const updated=(await db.prepare('SELECT * FROM channels WHERE id=? AND faculty_id=?').get(channel.id,faculty));res.json({channel:{...updated,read_only:!!updated.read_only}});
  });
  app.patch('/api/admin/users/:id', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const target=(await db.prepare('SELECT * FROM users WHERE id=?').get(asId(req.params.id)));
    if(!target||target.account_status==='deleted')throw problem(404,'Utilisateur introuvable.');
    if(target.account_status!=='approved')throw problem(409,'Validez la demande d’inscription avant de modifier ce compte.');
    if('account_status' in req.body||'admission_status' in req.body)throw problem(400,'Utilisez la validation des inscriptions pour modifier cet état.');
    const global=req.user.role==='global_admin';
    if(!global&&(target.faculty_id!==req.user.faculty_id||!['student','moderator'].includes(target.role)))throw problem(403,'Vous ne pouvez pas gérer ce compte.');
    if(req.body.faculty_id!==undefined&&!global)throw problem(403,'Seul l’administrateur global peut modifier une faculté.');
    if(req.body.role!==undefined&&(!ROLES.includes(req.body.role)||!global&&!['student','moderator'].includes(req.body.role)))throw problem(403,'Rôle non autorisé.');
    if(req.body.disabled!==undefined&&typeof req.body.disabled!=='boolean')throw problem(400,'État du compte invalide.');
    if(target.id===req.user.id&&(req.body.disabled===true||req.body.role&&req.body.role!==target.role))throw problem(400,'Vous ne pouvez pas désactiver ou rétrograder votre propre compte.');
    if(req.body.faculty_id!==undefined&&req.body.faculty_id!==null&&!(await db.prepare('SELECT 1 FROM faculties WHERE id=?').get(req.body.faculty_id)))throw problem(400,'Faculté invalide.');
    (await transaction(async ()=>{
      const current=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(target.id);
      if(!current||current.account_status==='deleted')throw problem(404,'Utilisateur introuvable.');
      if(current.account_status!=='approved')throw problem(409,'Validez la demande d’inscription avant de modifier ce compte.');
      if(!global&&(current.faculty_id!==req.user.faculty_id||!['student','moderator'].includes(current.role)))throw problem(403,'Vous ne pouvez pas gérer ce compte.');
      if(req.body.faculty_id!==undefined&&!filiereBelongsToFaculty(req.body.faculty_id,current.filiere_id))await db.prepare('UPDATE users SET filiere_id=NULL,current_semester=1 WHERE id=?').run(target.id);
      for(const key of ['faculty_id','role','disabled'])if(req.body[key]!==undefined)(await db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(key==='disabled'?(req.body[key]?1:0):req.body[key],target.id));
      if(req.body.faculty_id!==undefined||req.body.disabled===true||req.body.role!==undefined)await db.prepare('UPDATE users SET session_version=session_version+1,auth_revoked_at=? WHERE id=?').run(now(),target.id);
    }));
    if(target.auth_user_id&&(req.body.faculty_id!==undefined||req.body.disabled===true||req.body.role!==undefined))await auth.revokeUserSessions(req,target.auth_user_id);
    for(const stream of clients.get(target.id)||[])stream.end();
    (await broadcast(target.faculty_id));if(req.body.faculty_id)(await broadcast(req.body.faculty_id));
    res.json({user:publicUser((await db.prepare('SELECT * FROM users WHERE id=?').get(target.id)))});
  });
  app.patch('/api/admin/reports/:id', requireFaculty, role('moderator','faculty_admin','global_admin'), async (req,res) => {
    const report=(await db.prepare('SELECT * FROM reports WHERE id=?').get(asId(req.params.id)));
    if(!report)throw problem(404,'Signalement introuvable.');
    if(req.user.role!=='global_admin'&&report.faculty_id!==req.user.faculty_id)throw problem(403,'Signalement d’une autre faculté.');
    if(!['open','reviewed','resolved'].includes(req.body.status))throw problem(400,'Statut invalide.');
    (await db.prepare('UPDATE reports SET status=? WHERE id=?').run(req.body.status,report.id));res.json({ok:true});
  });
  app.patch('/api/admin/contacts/:id', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const contact=(await db.prepare('SELECT * FROM contacts WHERE id=?').get(asId(req.params.id)));
    if(!contact)throw problem(404,'Demande introuvable.');
    if(req.user.role!=='global_admin'&&contact.faculty_id!==req.user.faculty_id)throw problem(403,'Demande d’une autre faculté.');
    if(!['open','resolved'].includes(req.body.status))throw problem(400,'Statut invalide.');
    (await db.prepare('UPDATE contacts SET status=? WHERE id=?').run(req.body.status,contact.id));
    if(req.body.reply&&contact.user_id&&contact.faculty_id){const reply=string(req.body.reply,'Réponse',4000);(await db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)').run(contact.user_id,contact.faculty_id,'admin',`Réponse : ${contact.subject}`,reply,'/app/notifications',now()));(await broadcast(contact.faculty_id));}
    res.json({ok:true});
  });
  app.post('/api/admin/announcements', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const content=string(req.body.content,'Annonce',6000);
    const targets=(await publicationFaculties(req)),announcements=[];
    (await transaction(async ()=>{for(const faculty of targets){const id=Number((await db.prepare('INSERT INTO announcements (faculty_id,content,channel,author_id,created_at) VALUES (?,?,\'important\',?,?)').run(faculty,content,req.user.id,now())).lastInsertRowid);(await notify(faculty,'announcements','Nouvelle annonce',content,`/app/announcements#announcement-${id}`,req.user.id));announcements.push((await announcement((await db.prepare('SELECT * FROM announcements WHERE id=?').get(id)))));}}));
    await Promise.all(targets.map(faculty=>broadcast(faculty)));res.status(201).json({announcement:announcements[0],announcements});
  });
  app.post('/api/admin/events', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const title=string(req.body.title,'Titre',180),date=string(req.body.date,'Date',10),time=string(req.body.time||'09:00','Horaire',50),type=req.body.type||'event';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw problem(400,'Date invalide.');
    if(!['exam','rattrapage','deadline','registration','event','defense'].includes(type))throw problem(400,'Type d’événement invalide.');
    const targets=(await publicationFaculties(req)),events=[];
    (await transaction(async ()=>{for(const faculty of targets){const id=Number((await db.prepare('INSERT INTO events (faculty_id,title,date,time,type) VALUES (?,?,?,?,?)').run(faculty,title,date,time,type)).lastInsertRowid);(await notify(faculty,'calendar','Nouveau rendez-vous',`${title} · ${date}`,`/app/calendar#event-${id}`,req.user.id));events.push({id,title,date,time,type});}}));
    await Promise.all(targets.map(faculty=>broadcast(faculty)));res.status(201).json({event:events[0],events});
  });
  app.patch('/api/admin/resources/:id', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const r=(await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id)));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    const values={};
    if(req.body.title!==undefined)values.title=string(req.body.title,'Titre',180);
    if(req.body.category!==undefined){if(!CATEGORIES.includes(req.body.category))throw problem(400,'Catégorie invalide.');values.category=req.body.category;}
    const category=values.category||r.category;
    const rawSemester=req.body.semester??r.semester;
    const semester=category==='general'&&r.semester===null&&(rawSemester===null||Number(rawSemester)===0)?null:Number(rawSemester);
    if((semester===null&&category!=='general')||(semester!==null&&(!Number.isInteger(semester)||semester<1||semester>6)))throw problem(400,'Semestre invalide.');
    values.semester=semester;
    if(req.body.module!==undefined)values.module=string(req.body.module,'Module',120,false);
    if(req.body.status!==undefined){if(!['new','popular','corrected','updated'].includes(req.body.status))throw problem(400,'Statut invalide.');values.status=req.body.status;}
    if(req.body.part_number!==undefined){const part=Number(req.body.part_number);if(!Number.isInteger(part)||part<1||part>999)throw problem(400,'Partie invalide.');values.part_number=part;}
    if(req.body.teacher_name!==undefined)values.teacher_name=string(req.body.teacher_name,'Professeur / auteur',120);
    await transaction(async()=>{
      const module=values.module??r.module;
      values.module_id=module?await moduleId(r.faculty_id,r.filiere_id,semester,module):null;
      for(const [key,value]of Object.entries(values))await db.prepare(`UPDATE resources SET ${key}=? WHERE id=?`).run(value,r.id);
    });
    (await broadcast(r.faculty_id));res.json({resource:(await resource((await db.prepare('SELECT * FROM resources WHERE id=?').get(r.id))))});
  });
  app.post('/api/admin/resources/:id/replace', requireFaculty, role('faculty_admin','global_admin'), upload.single('file'), async (req,res) => {
    const r=(await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id)));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    if(!req.file?.size)throw problem(400,'Sélectionnez un fichier.');
    const filename=basename(req.file.originalname).replace(/[\u0000-\u001f]/g,'').slice(0,180);
    const mime=detectFile(req.file.buffer,filename),hash=digest(req.file.buffer);
    if(hash===r.sha256)throw problem(409,'Le fichier est identique à la version actuelle.');
    const duplicate=(await db.prepare('SELECT * FROM resources WHERE faculty_id=? AND filiere_id=? AND sha256=? AND removed=0 AND id<>?').get(r.faculty_id,r.filiere_id,hash,r.id));
    if(duplicate)return res.status(409).json({error:'Ce fichier existe déjà dans votre faculté.',resource:(await resource(duplicate))});
    let objectKey,uploaded=false;
    try{await transaction(async()=>{
      const current=await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0 FOR UPDATE').get(r.id);
      if(!current)throw problem(404,'Ressource introuvable.');
      if(hash===current.sha256)throw problem(409,'Le fichier est identique à la version actuelle.');
      const selectedModule=current.module_id||await moduleId(current.faculty_id,current.filiere_id,current.semester,current.module||'');
      objectKey=current.filiere_id&&current.semester?resourceObjectKey({filiereId:current.filiere_id,semester:current.semester,moduleId:selectedModule,filename,prefix:'resource-versions'}):`resource-versions/${current.id}/${randomUUID()}${extname(filename).toLowerCase()}`;
      uploaded=true;await storage.put(objectKey,req.file.buffer,mime);
      const addVersion=db.prepare('INSERT INTO resource_versions (resource_id,version,filename,object_key,sha256,size,mime,updated_at,editor_id) VALUES (?,?,?,?,?,?,?,?,?)');
      if(!await db.prepare('SELECT 1 FROM resource_versions WHERE resource_id=? AND version=?').get(current.id,current.version))await addVersion.run(current.id,current.version,current.filename,current.object_key,current.sha256,current.size,current.mime,current.created_at,current.author_id);
      await addVersion.run(current.id,current.version+1,filename,objectKey,hash,req.file.size,mime,now(),req.user.id);
      await db.prepare("UPDATE resources SET filename=?,object_key=?,stored_name='',sha256=?,size=?,mime=?,version=version+1,status='updated' WHERE id=?").run(filename,objectKey,hash,req.file.size,mime,current.id);
      await notify(current.faculty_id,'resources','Version mise à jour',current.title,resourcePath(current),req.user.id);
    });}catch(error){
      if(uploaded)try{await storage.delete(objectKey);}catch{console.error('[CampusLink storage] Replacement cleanup failed.');}
      if(error.code==='23505')throw problem(409,'Ce fichier existe déjà dans votre faculté.');
      throw error;
    }
    (await broadcast(r.faculty_id));res.json({resource:(await resource((await db.prepare('SELECT * FROM resources WHERE id=?').get(r.id))))});
  });
  app.delete('/api/admin/resources/:id', requireFaculty, role('faculty_admin','global_admin'), async (req,res) => {
    const r=(await db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id)));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    (await transaction(async ()=>{(await db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(r.id));(await db.prepare('UPDATE messages SET resource_id=NULL WHERE resource_id=?').run(r.id));(await db.prepare('UPDATE announcements SET resource_id=NULL WHERE resource_id=?').run(r.id));}));
    (await broadcast(r.faculty_id));res.json({ok:true});
  });
  app.post('/api/admin/messages/:id/remove', requireFaculty, requireChat, role('moderator','faculty_admin','global_admin'), async (req,res) => {
    const m=req.user.role==='global_admin'?(await db.prepare('SELECT * FROM messages WHERE id=? AND removed=0').get(asId(req.params.id))):(await scoped('messages',req.params.id,req,true));
    if(!m)throw problem(404,'Message introuvable.');
    await removeChatMessage(m);res.json({ok:true});
  });

  app.use('/api', (_req,_res,next)=>next(problem(404,'Route API introuvable.')));
  const dist=resolve('dist');
  if(existsSync(join(dist,'index.html'))){app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(join(dist,'index.html')));}
  app.use((err,_req,res,_next)=>{
    if(res.headersSent||_req.aborted||(res.destroyed&&err.code==='ERR_STREAM_PREMATURE_CLOSE'))return;
    const status=err instanceof multer.MulterError?400:(err.code==='23505'?409:err.status||500);
    const message=err instanceof multer.MulterError?(err.code==='LIMIT_FILE_SIZE'?'Le fichier dépasse la limite de 20 Mo.':'Téléversement invalide.'):(err.type==='entity.parse.failed'?'Requête JSON invalide.':err.code==='23505'?'Cet élément existe déjà.':status===500?'Une erreur serveur est survenue. Réessayez.':err.message);
    if(status===500)console.error('[CampusLink API]',err.code||'UNEXPECTED_ERROR');
    if(Number.isSafeInteger(err.retryAfter)&&err.retryAfter>0)res.set('Retry-After',String(err.retryAfter));
    res.status(status).json({error:message,...(err.code&&['ACCOUNT_PENDING','ACCOUNT_REJECTED'].includes(err.code)?{code:err.code}:{})});
  });
  return app;
}
