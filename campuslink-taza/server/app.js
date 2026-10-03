import express from 'express';
import multer from 'multer';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { openDatabase, digest, hashPassword, verifyPassword } from './db.js';
import { seedDatabase } from './seed.js';
import { slug } from '../shared/paths.js';
import { getFilieres, filiereBelongsToFaculty, getChatSemester } from '../shared/studies.js';

const CATEGORIES = ['courses', 'exercises', 'exams', 'rattrapage', 'general'];
const CHANNELS = ['general', 'filiere', 'important', 'help', 'life'];
const ROLES = ['student', 'moderator', 'faculty_admin', 'global_admin'];
const PREF_KEYS = ['resources', 'announcements', 'important', 'admin', 'calendar'];
const RESOURCE_TYPES = ['courses','cours','exercises','exercise','exams','exam','td','tp','correction','image','pdf','document','other','rattrapage'];
const now = () => new Date().toISOString();
const sessionAge = 30 * 24 * 60 * 60 * 1000;
const resourcePath = r => `/app/resources/${r.category}${r.semester ? `/s${r.semester}` : ''}${r.module ? `/${encodeURIComponent(slug(r.module))}` : ''}#resource-${r.id}`;
const messagePath = m => `/app/chat/${m.channel}${m.channel==='filiere'?`?semester=${m.semester}`:''}#message-${m.id}`;
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

export function createApp({ dataDir = resolve('data'), seed = true, studentPassword, adminPassword, appOrigin = process.env.APP_ORIGIN } = {}) {
  const db = openDatabase(dataDir);
  if (seed) seedDatabase(db, dataDir, {studentPassword, adminPassword});
  const channelDefaults={general:['Chat général','Échanges autour des cours et de la vie universitaire.'],filiere:['Chats de filière','Échanges de votre filière par groupes de semestres.'],important:['Discussions importantes','Informations prioritaires et échéances à retenir.'],help:['Entraide','Questions, révisions et groupes de travail.'],life:['Vie étudiante','Clubs, rencontres et activités sur le campus.']};
  const addChannel=db.prepare('INSERT OR IGNORE INTO channels (id,faculty_id,name,description) VALUES (?,?,?,?)');
  for(const faculty of db.prepare('SELECT id FROM faculties').all())for(const [id,[name,description]]of Object.entries(channelDefaults))addChannel.run(id,faculty.id,name,description);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '3mb' }));
  const clients = new Map();
  const heartbeats = new Set();
  const attempts = new Map();
  const contactAttempts = new Map();
  const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: 20 * 1024 * 1024, files: 1, fields: 12, fieldSize: 10000}});
  app.locals.db = db;
  app.locals.dataDir = dataDir;
  let closed=false;
  app.locals.endStreams = () => { for(const heartbeat of heartbeats)clearInterval(heartbeat);heartbeats.clear();for(const stream of clients.values())for(const res of stream)res.end();clients.clear(); };
  app.locals.close = () => {if(closed)return;closed=true;app.locals.endStreams();db.close();};

  app.use('/api', (req, res, next) => {
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
    const cookies = (req.get('cookie') || '').split(';').map(v => v.trim().split('='));
    const token = cookies.find(([key]) => key === 'campus_session')?.[1];
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const row = db.prepare('SELECT u.*, s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0').get(digest(token), Date.now());
      if (row) { req.user = row; req.sessionHash = row.session_hash; db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(), row.id); }
    }
    next();
  });

  function publicUser(u) { return {id:u.id, username:u.username, name:u.name, avatar:u.avatar, role:u.role, faculty_id:u.faculty_id, filiere_id:u.filiere_id, current_semester:u.current_semester, language:u.language, preferences:JSON.parse(u.preferences), ...(u.disabled !== undefined ? {disabled:!!u.disabled} : {})}; }
  function author(id) { const u = db.prepare('SELECT id,name,username,avatar,role FROM users WHERE id=?').get(id); return u || {id, name:'Utilisateur', username:'', avatar:'', role:'student'}; }
  function requireUser(req, _res, next) { if (!req.user) return next(problem(401, 'Connectez-vous pour accéder à votre communauté.')); next(); }
  function requireFaculty(req, _res, next) {
    if (!req.user) return next(problem(401, 'Connectez-vous pour accéder à votre communauté.'));
    if (!req.user.faculty_id) return next(problem(403, 'Choisissez votre faculté avant de continuer.'));
    const asked = req.query.faculty_id || req.query.faculty;
    if (asked && asked !== req.user.faculty_id) return next(problem(403, 'Cet espace appartient à une autre faculté.'));
    next();
  }
  function role(...roles) { return (req, _res, next) => roles.includes(req.user.role) ? next() : next(problem(403, 'Vous n’avez pas l’autorisation d’effectuer cette action.')); }
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
    return item && !item.removed && item.faculty_id===user.faculty_id && (item.channel!=='filiere'||hasStudies(user)&&item.filiere_id===user.filiere_id&&[1,3,5].includes(item.semester));
  }
  function canReadAnnouncement(item,user) {
    if(!item||item.faculty_id!==user.faculty_id)return false;
    if(!item.message_id)return true;
    return canReadMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(item.message_id),user);
  }
  function canReadItem(table,item,user) {
    if(table==='messages')return canReadMessage(item,user);
    if(table==='announcements')return canReadAnnouncement(item,user);
    return item&&!item.removed&&item.faculty_id===user.faculty_id;
  }
  function canReadNotification(item,user) {
    const linkedAnnouncement=String(item.path).match(/#announcement-(\d+)/);
    if(linkedAnnouncement)return canReadAnnouncement(db.prepare('SELECT * FROM announcements WHERE id=?').get(Number(linkedAnnouncement[1])),user);
    const linkedMessage=String(item.path).match(/#message-(\d+)/);
    if(linkedMessage)return canReadMessage(db.prepare('SELECT * FROM messages WHERE id=?').get(Number(linkedMessage[1])),user);
    return true;
  }
  function scoped(table, id, req, moderation=false) {
    const item = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(asId(id));
    if (!item || item.removed) throw problem(404, 'Élément introuvable.');
    if (item.faculty_id !== req.user.faculty_id) throw problem(403, 'Cet élément appartient à une autre faculté.');
    if(!moderation&&!canReadItem(table,item,req.user))throw problem(403,'Cet élément appartient à une autre filière.');
    return item;
  }
  function message(m, viewerId) {
    const reactions = db.prepare('SELECT reaction, COUNT(*) AS n FROM reactions WHERE message_id=? GROUP BY reaction').all(m.id);
    return {...m, author:author(m.author_id), pinned:!!m.pinned, reactions:{like:0,heart:0,...Object.fromEntries(reactions.map(r=>[r.reaction,r.n]))}, my_reactions:db.prepare('SELECT reaction FROM reactions WHERE message_id=? AND user_id=?').all(m.id,viewerId).map(r=>r.reaction), author_id:undefined, removed:undefined};
  }
  function resource(r,viewer) {
    const {stored_name, sha256, author_id, removed, ...safe} = r;
    const source=safe.message_id?db.prepare('SELECT * FROM messages WHERE id=?').get(safe.message_id):null;
    if(viewer&&safe.message_id&&!canReadMessage(source,viewer))safe.message_id=null;
    safe.chat_semester=safe.message_id&&source?.channel==='filiere'?source.semester:null;
    return {...safe, author:author(author_id), versions:db.prepare('SELECT version,filename,updated_at,editor_id FROM resource_versions WHERE resource_id=? ORDER BY version DESC').all(r.id).map(v=>({...v,created_at:v.updated_at,author:author(v.editor_id),editor_id:undefined}))};
  }
  function announcement(a) { const {author_id, ...safe} = a;const source=a.message_id?db.prepare('SELECT * FROM messages WHERE id=?').get(a.message_id):null;return {...safe, semester:source?.semester??null, filiere_id:source?.filiere_id??null, author:author(author_id), pinned:!!a.pinned}; }
  function broadcast(faculty,filiereId=null) {
    for (const [id, streams] of clients) {
      const user = db.prepare('SELECT faculty_id,filiere_id,disabled FROM users WHERE id=?').get(id);
      for (const res of streams) {
        if (!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(res.sessionHash,Date.now())) {res.end();continue;}
        if (user?.disabled || user?.faculty_id !== faculty) continue;
        if(filiereId&&user?.filiere_id!==filiereId)continue;
        res.write('event: update\ndata: {}\n\n');
      }
    }
  }
  function notify(faculty, type, title, body, path, exclude = null,filiereId=null) {
    const statement = db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)');
    for (const u of db.prepare('SELECT id,filiere_id,preferences FROM users WHERE faculty_id=? AND disabled=0').all(faculty)) {
      if (u.id === exclude || JSON.parse(u.preferences)[type] === false) continue;
      if(filiereId&&u.filiere_id!==filiereId)continue;
      statement.run(u.id, faculty, type, title, body.slice(0, 240), path, now());
    }
  }
  function transaction(callback) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  function publicationFaculties(req) {
    const target=req.body.faculty_id || req.user.faculty_id;
    if(req.user.role!=='global_admin'&&target!==req.user.faculty_id)throw problem(403,'Vous ne pouvez publier que dans votre faculté.');
    if(target==='all'&&req.user.role==='global_admin')return db.prepare('SELECT id FROM faculties').all().map(f=>f.id);
    if(!db.prepare('SELECT 1 FROM faculties WHERE id=?').get(target))throw problem(400,'Faculté invalide.');
    return [target];
  }
  function checkChannelWrite(req,channel){const row=db.prepare('SELECT read_only FROM channels WHERE id=? AND faculty_id=?').get(channel,req.user.faculty_id);if(row?.read_only&&req.user.role==='student')throw problem(403,'Cette discussion est en lecture seule. L’administration peut toujours y publier.');}
  function setCookie(req, res, token) { res.cookie('campus_session', token, { httpOnly:true, sameSite:'lax', secure: req.secure || process.env.COOKIE_SECURE === 'true', path:'/', maxAge:sessionAge }); }
  function newSession(req, res, userId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), userId, Date.now()+sessionAge);
    setCookie(req,res,token);
  }

  app.get('/api/health', (_req, res) => res.json({ok:true}));
  app.get('/api/session', (req, res) => res.json({user:req.user ? publicUser(req.user) : null}));
  app.post('/api/login', (req, res) => {
    const username = string(req.body.username, 'Nom d’utilisateur', 40);
    const password = passwordValue(req.body.password);
    const key = req.ip;
    const attempt = attempts.get(key);
    if (attempt && attempt.expires > Date.now() && attempt.count >= 12) throw problem(429, 'Trop de tentatives. Réessayez dans 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);
    // Always perform scrypt, including unknown usernames.
    const valid = verifyPassword(password, u?.password_hash || '00000000000000000000000000000000:'+'00'.repeat(64));
    if (!u || !valid || u.disabled) {
      attempts.set(key, {count:attempt?.expires > Date.now() ? attempt.count+1 : 1, expires:Date.now()+900000});
      throw problem(401, 'Nom d’utilisateur ou mot de passe incorrect.');
    }
    attempts.delete(key);
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    newSession(req,res,u.id);
    res.json({user:publicUser(u)});
  });
  app.post('/api/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    for (const stream of clients.get(req.user?.id)||[]) if(stream.sessionHash===req.sessionHash)stream.end();
    res.clearCookie('campus_session', {httpOnly:true, sameSite:'lax', path:'/'});
    res.json({ok:true});
  });
  app.get('/api/faculties', requireUser, (req, res) => {
    if (req.user.faculty_id && req.user.role !== 'global_admin') throw problem(403, 'Votre faculté est déjà associée à votre compte.');
    res.json({faculties:db.prepare('SELECT f.*, (SELECT COUNT(*) FROM users u WHERE u.faculty_id=f.id AND u.disabled=0) AS members FROM faculties f').all().map(f=>({...f,online:0}))});
  });
  app.post('/api/faculty', requireUser, (req, res) => {
    if (req.user.faculty_id) throw problem(403, 'Ce choix est définitif. Seul l’administrateur pourra modifier votre faculté.');
    if (req.body.confirmed !== true) throw problem(400, 'Confirmez votre choix définitif de faculté.');
    const faculty = db.prepare('SELECT * FROM faculties WHERE id=?').get(req.body.faculty_id || '');
    if (!faculty) throw problem(400, 'Faculté invalide.');
    transaction(() => {
      db.prepare('UPDATE users SET faculty_id=? WHERE id=? AND faculty_id IS NULL').run(faculty.id,req.user.id);
      const insert = db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)');
      for (const a of db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC').all(faculty.id).filter(a=>canReadAnnouncement(a,{...req.user,faculty_id:faculty.id})).slice(0,2)) insert.run(req.user.id,faculty.id,'announcements','Annonce de votre faculté',a.content.slice(0,200),`/app/announcements#announcement-${a.id}`,a.created_at);
      for (const r of db.prepare("SELECT * FROM resources WHERE faculty_id=? AND category<>'general' ORDER BY created_at DESC LIMIT 2").all(faculty.id)) insert.run(req.user.id,faculty.id,'resources','Ressource à découvrir',r.title,resourcePath(r),r.created_at);
      const ev = db.prepare('SELECT * FROM events WHERE faculty_id=? AND date>=? ORDER BY date LIMIT 1').get(faculty.id,now().slice(0,10));
      if (ev) insert.run(req.user.id,faculty.id,'calendar','Prochain rendez-vous',`${ev.title} · ${ev.date}`,`/app/calendar#event-${ev.id}`,now());
    });
    res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
  });

  app.get('/api/studies', requireFaculty, (req,res) => res.json({filieres:getFilieres(req.user.faculty_id),user:publicUser(req.user)}));
  app.post('/api/studies', requireFaculty, (req,res) => {
    if('faculty_id' in req.body||'faculty' in req.body)throw problem(400,'Votre faculté est déjà connue.');
    const filiere=string(req.body.filiere_id,'Filière',80);
    if(!filiereBelongsToFaculty(req.user.faculty_id,filiere))throw problem(400,'Choisissez une filière de votre faculté.');
    const semester=semesterValue(req.body.current_semester??1);
    db.prepare('UPDATE users SET filiere_id=?,current_semester=? WHERE id=?').run(filiere,semester,req.user.id);
    res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
  });

  app.get('/api/bootstrap', requireFaculty, (req, res) => {
    const faculty = db.prepare('SELECT * FROM faculties WHERE id=?').get(req.user.faculty_id);
    const members = db.prepare('SELECT id,name,username,avatar,role,faculty_id,last_seen FROM users WHERE faculty_id=? AND disabled=0 ORDER BY name').all(faculty.id).map(({last_seen,...u})=>({...u,online:u.id===req.user.id || !!(last_seen && Date.parse(last_seen)>Date.now()-300000)}));
    const chatOnline=hasStudies(req.user)?db.prepare('SELECT COUNT(*) AS n FROM users WHERE faculty_id=? AND filiere_id=? AND disabled=0 AND (id=? OR last_seen>?)').get(faculty.id,req.user.filiere_id,req.user.id,new Date(Date.now()-300000).toISOString()).n:0;
    res.json({
      user:publicUser(req.user),filieres:getFilieres(faculty.id),faculty:{...faculty,members:members.length,online:members.filter(u=>u.online).length,chat_online:chatOnline},
      channels:db.prepare('SELECT * FROM channels WHERE faculty_id=?').all(faculty.id).map(c=>({...c,read_only:!!c.read_only})),
      messages:db.prepare('SELECT * FROM messages WHERE faculty_id=? AND removed=0 ORDER BY created_at,id').all(faculty.id).filter(m=>canReadMessage(m,req.user)).map(m=>message(m,req.user.id)),
      resources:db.prepare('SELECT * FROM resources WHERE faculty_id=? AND removed=0 ORDER BY created_at DESC,id DESC').all(faculty.id).map(r=>resource(r,req.user)),
      announcements:db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC,id DESC').all(faculty.id).filter(a=>canReadAnnouncement(a,req.user)).map(announcement),
      notifications:db.prepare('SELECT id,type,title,body,path,created_at,read FROM notifications WHERE user_id=? AND faculty_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(req.user.id,faculty.id).filter(n=>canReadNotification(n,req.user)).map(n=>({...n,read:!!n.read})),
      members,events:db.prepare('SELECT id,title,date,time,type FROM events WHERE faculty_id=? ORDER BY date,time').all(faculty.id),
      saved:db.prepare('SELECT type,target_id AS id FROM saved WHERE user_id=?').all(req.user.id).filter(s=>{const table={resource:'resources',message:'messages',announcement:'announcements'}[s.type];return table&&canReadItem(table,db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(s.id),req.user);}),
      history:db.prepare('SELECT h.resource_id,h.opened_at FROM history h JOIN resources r ON r.id=h.resource_id WHERE h.user_id=? AND r.faculty_id=? AND r.removed=0 ORDER BY h.opened_at DESC LIMIT 20').all(req.user.id,faculty.id),
    });
  });
  app.get('/api/messages', requireFaculty, (req,res) => {
    const channel=req.query.channel||'general';
    if(!CHANNELS.includes(channel))throw problem(400,'Discussion invalide.');
    if(channel==='filiere'&&!hasStudies(req.user))throw problem(403,'Choisissez votre filière avant d’accéder aux chats.');
    if(channel==='filiere'&&req.query.filiere_id&&req.query.filiere_id!==req.user.filiere_id)throw problem(403,'Ce chat appartient à une autre filière.');
    const semester=channel==='filiere'?getChatSemester(semesterValue(req.query.semester)):null;
    res.json({messages:db.prepare('SELECT * FROM messages WHERE faculty_id=? AND channel=? AND removed=0 ORDER BY created_at,id').all(req.user.faculty_id,channel).filter(m=>canReadMessage(m,req.user)&&(channel!=='filiere'||m.semester===semester)).map(m=>message(m,req.user.id))});
  });
  app.get('/api/messages/:id', requireFaculty, (req,res) => res.json({message:message(scoped('messages',req.params.id,req),req.user.id)}));
  app.get('/api/events/stream', requireFaculty, (req,res) => {
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.flushHeaders(); res.write(': connected\n\n');
    res.sessionHash=req.sessionHash;
    if (!clients.has(req.user.id)) clients.set(req.user.id,new Set());
    clients.get(req.user.id).add(res);
    const heartbeat = setInterval(()=>{if(!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(res.sessionHash,Date.now()))res.end();else res.write(': heartbeat\n\n');},15000);
    heartbeats.add(heartbeat);
    req.on('close',()=>{ clearInterval(heartbeat);heartbeats.delete(heartbeat); clients.get(req.user.id)?.delete(res); if (!clients.get(req.user.id)?.size) clients.delete(req.user.id); });
  });

  app.post('/api/messages', requireFaculty, (req,res) => {
    const content = string(req.body.content,'Message',8000);
    const channel = req.body.channel || 'general';
    if (!CHANNELS.includes(channel)) throw problem(400,'Discussion invalide.');
    checkChannelWrite(req,channel);
    const scope=chatScope(req,channel);
    const reply = req.body.reply_to ? scoped('messages',req.body.reply_to,req) : null;
    if (reply && reply.channel !== channel) throw problem(400,'La réponse doit rester dans la discussion d’origine.');
    if(reply&&channel==='filiere'&&reply.semester!==scope.semester)throw problem(400,'La réponse doit rester dans le même groupe de semestres.');
    const id = Number(db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,reply_to,filiere_id,semester) VALUES (?,?,?,?,?,?,?,?)').run(req.user.faculty_id,channel,content,req.user.id,now(),reply?.id||null,scope.filiere_id,scope.semester).lastInsertRowid);
    if (channel==='important') notify(req.user.faculty_id,'important','Nouvelle discussion importante',content,`/app/chat/important#message-${id}`,req.user.id);
    broadcast(req.user.faculty_id,scope.filiere_id); res.status(201).json({message:message(db.prepare('SELECT * FROM messages WHERE id=?').get(id),req.user.id)});
  });
  app.post('/api/messages/:id/reaction', requireFaculty, (req,res) => {
    const m = scoped('messages',req.params.id,req);
    if (!['like','heart'].includes(req.body.reaction)) throw problem(400,'Réaction invalide.');
    const exists = db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND reaction=?').get(m.id,req.user.id,req.body.reaction);
    if (exists) db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND reaction=?').run(m.id,req.user.id,req.body.reaction);
    else db.prepare('INSERT INTO reactions VALUES (?,?,?)').run(m.id,req.user.id,req.body.reaction);
    broadcast(req.user.faculty_id,m.channel==='filiere'?m.filiere_id:null);res.json({message:message(m,req.user.id)});
  });
  app.post('/api/messages/:id/pin', requireFaculty, role('moderator','faculty_admin','global_admin'), (req,res) => {
    const m = scoped('messages',req.params.id,req);
    const pinned = !m.pinned;
    transaction(()=>{
      db.prepare('UPDATE messages SET pinned=? WHERE id=?').run(pinned?1:0,m.id);
      if (pinned) {
        const id = Number(db.prepare('INSERT INTO announcements (faculty_id,content,message_id,channel,author_id,created_at,resource_id,pinned) VALUES (?,?,?,?,?,?,?,1)').run(m.faculty_id,m.content,m.id,m.channel,m.author_id,m.created_at,m.resource_id).lastInsertRowid);
        notify(m.faculty_id,'announcements','Message épinglé',m.content,`/app/announcements#announcement-${id}`,req.user.id,m.channel==='filiere'?m.filiere_id:null);
      } else db.prepare('DELETE FROM announcements WHERE message_id=?').run(m.id);
    });
    broadcast(m.faculty_id,m.channel==='filiere'?m.filiere_id:null); res.json({pinned});
  });

  app.post('/api/uploads', requireFaculty, upload.single('file'), (req,res) => {
    if (!req.file?.size) throw problem(400,'Sélectionnez un fichier.');
    const category = req.body.category;
    const channel = req.body.channel || 'general';
    if (!CATEGORIES.includes(category)) throw problem(400,'Choisissez un type de ressource.');
    if (!CHANNELS.includes(channel)) throw problem(400,'Discussion invalide.');
    checkChannelWrite(req,channel);
    const filiere=string(req.body.filiere_id,'Filière',80);
    if(!filiereBelongsToFaculty(req.user.faculty_id,filiere))throw problem(400,'Choisissez une filière de votre faculté.');
    const semester = semesterValue(req.body.semester);
    const scope=chatScope(req,channel,'chat_semester');
    const resourceType=string(req.body.resource_type,'Type de ressource',40).toLowerCase();
    if(!RESOURCE_TYPES.includes(resourceType))throw problem(400,'Choisissez un type de ressource.');
    const filename = basename(req.file.originalname).replace(/[\u0000-\u001f]/g,'').slice(0,180);
    const title = string(req.body.title,'Titre',180);
    const module = string(req.body.module,'Module',120);
    const content = string(req.body.content || `Je partage « ${title} ».`,'Message',8000);
    const mime = detectFile(req.file.buffer,filename);
    const hash = digest(req.file.buffer);
    const duplicate = db.prepare('SELECT * FROM resources WHERE faculty_id=? AND sha256=? AND removed=0').get(req.user.faculty_id,hash);
    if (duplicate) return res.status(409).json({error:'Un fichier identique existe déjà dans les ressources de votre faculté.',resource:resource(duplicate,req.user)});
    const reply = req.body.reply_to ? scoped('messages',req.body.reply_to,req) : null;
    if (reply && reply.channel!==channel) throw problem(400,'La réponse doit rester dans la discussion d’origine.');
    if(reply&&channel==='filiere'&&reply.semester!==scope.semester)throw problem(400,'La réponse doit rester dans le même groupe de semestres.');
    const stored = randomUUID()+extname(filename).toLowerCase();
    const filePath = join(dataDir,'files',stored);
    writeFileSync(filePath,req.file.buffer,{mode:0o600});
    let id;
    try {
      transaction(()=>{
        const created = now();
        const messageId = Number(db.prepare('INSERT INTO messages (faculty_id,channel,content,author_id,created_at,reply_to,filiere_id,semester) VALUES (?,?,?,?,?,?,?,?)').run(req.user.faculty_id,channel,content,req.user.id,created,reply?.id||null,scope.filiere_id,scope.semester).lastInsertRowid);
        id = Number(db.prepare('INSERT INTO resources (faculty_id,title,filename,stored_name,sha256,category,semester,module,author_id,created_at,size,mime,message_id,channel,filiere_id,resource_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.faculty_id,title,filename,stored,hash,category,semester,module,req.user.id,created,req.file.size,mime,messageId,channel,filiere,resourceType).lastInsertRowid);
        db.prepare('UPDATE messages SET resource_id=? WHERE id=?').run(id,messageId);
        if (category!=='general') notify(req.user.faculty_id,'resources','Nouvelle ressource',`${title}${semester ? ` · S${semester}` : ''}`,resourcePath({id,category,semester,module}),req.user.id);
        if (channel==='important') notify(req.user.faculty_id,'important','Nouvelle discussion importante',content,`/app/chat/important#message-${messageId}`,req.user.id);
      });
    } catch(e) { unlinkSync(filePath); throw e; }
    broadcast(req.user.faculty_id);
    const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
    res.status(201).json({resource:resource(r,req.user),message:message(db.prepare('SELECT * FROM messages WHERE id=?').get(r.message_id),req.user.id)});
  });
  app.get('/api/files/:id', requireFaculty, (req,res,next) => {
    const r = scoped('resources',req.params.id,req);
    const filePath = resolve(dataDir,'files',r.stored_name);
    if (!existsSync(filePath)) throw problem(404,'Fichier indisponible. Signalez-le à l’administration.');
    const download = req.query.download==='1';
    db.prepare(`UPDATE resources SET ${download?'downloads':'views'}=${download?'downloads':'views'}+1 WHERE id=?`).run(r.id);
    db.prepare('INSERT INTO history (user_id,resource_id,opened_at) VALUES (?,?,?) ON CONFLICT(user_id,resource_id) DO UPDATE SET opened_at=excluded.opened_at').run(req.user.id,r.id,now());
    res.type(r.mime);
    res.set('Content-Disposition',`${download?'attachment':'inline'}; filename="${r.filename.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(r.filename)}`);
    res.set('Content-Security-Policy',"sandbox; default-src 'none'");
    res.sendFile(filePath,e=>{if(e)next(e);});
  });

  app.post('/api/saved', requireFaculty, (req,res) => {
    const table = {resource:'resources',message:'messages',announcement:'announcements'}[req.body.type];
    if (!table) throw problem(400,'Type invalide.');
    const target = scoped(table,req.body.id,req);
    const existing = db.prepare('SELECT 1 FROM saved WHERE user_id=? AND type=? AND target_id=?').get(req.user.id,req.body.type,target.id);
    if (existing) db.prepare('DELETE FROM saved WHERE user_id=? AND type=? AND target_id=?').run(req.user.id,req.body.type,target.id);
    else db.prepare('INSERT INTO saved VALUES (?,?,?)').run(req.user.id,req.body.type,target.id);
    res.json({saved:!existing});
  });
  app.post('/api/notifications/read', requireFaculty, (req,res) => {
    if (req.body.ids !== undefined) {
      if (!Array.isArray(req.body.ids) || req.body.ids.length>200) throw problem(400,'Liste invalide.');
      const statement = db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=? AND faculty_id=?');
      req.body.ids.forEach(id=>statement.run(asId(id),req.user.id,req.user.faculty_id));
    } else db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND faculty_id=?').run(req.user.id,req.user.faculty_id);
    res.json({ok:true});
  });
  app.post('/api/reports', requireFaculty, (req,res) => {
    const table = {resource:'resources',message:'messages',announcement:'announcements'}[req.body.target_type];
    if (!table) throw problem(400,'Élément à signaler invalide.');
    const target = scoped(table,req.body.target_id,req);
    const reason = string(req.body.reason,'Motif',150);
    const details = string(req.body.details||'','Détails',2000,false);
    const id = Number(db.prepare('INSERT INTO reports (faculty_id,reporter_id,target_type,target_id,reason,details,created_at) VALUES (?,?,?,?,?,?,?)').run(req.user.faculty_id,req.user.id,req.body.target_type,target.id,reason,details,now()).lastInsertRowid);
    for(const u of db.prepare("SELECT id FROM users WHERE (faculty_id=? AND role IN ('moderator','faculty_admin')) OR role='global_admin'").all(req.user.faculty_id)) db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)').run(u.id,req.user.faculty_id,'admin','Nouveau signalement',reason,'/app/admin',now());
    broadcast(req.user.faculty_id);res.status(201).json({id});
  });
  app.post('/api/contact', (req,res) => {
    const key=req.ip, attempt=contactAttempts.get(key);
    if(attempt && attempt.expires>Date.now() && attempt.count>=8) throw problem(429,'Trop de demandes. Réessayez dans une heure.');
    const name=string(req.body.name||req.user?.name||'','Nom',100,!req.user);
    const email=string(req.body.email||'','Adresse e-mail',160,!req.user);
    if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem(400,'Adresse e-mail invalide.');
    const subject=string(req.body.subject,'Objet',160), content=string(req.body.message,'Message',4000);
    const id=Number(db.prepare('INSERT INTO contacts (faculty_id,user_id,name,email,subject,message,created_at) VALUES (?,?,?,?,?,?,?)').run(req.user?.faculty_id||null,req.user?.id||null,name,email,subject,content,now()).lastInsertRowid);
    contactAttempts.set(key,{count:attempt?.expires>Date.now()?attempt.count+1:1,expires:Date.now()+3600000});
    res.status(201).json({id,ok:true});
  });

  app.patch('/api/profile', requireUser, (req,res) => {
    if ('faculty_id' in req.body || 'faculty' in req.body || 'role' in req.body || 'disabled' in req.body) throw problem(403,'Seul l’administrateur peut modifier votre identité universitaire.');
    const values={};
    if(req.body.username!==undefined){const username=string(req.body.username,'Nom d’utilisateur',40);if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw problem(400,'Utilisez 3 à 40 lettres, chiffres, points, tirets ou underscores.');if(db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?').get(username,req.user.id))throw problem(409,'Ce nom d’utilisateur est déjà utilisé.');values.username=username;}
    if(req.body.language!==undefined){if(!['fr','ar','en'].includes(req.body.language))throw problem(400,'Langue invalide.');values.language=req.body.language;}
    if(req.body.avatar!==undefined){
      const avatar=req.body.avatar;
      if(avatar==='')values.avatar='';
      else {
        if(typeof avatar!=='string'||avatar.length>1400000)throw problem(400,'Image trop volumineuse (1 Mo maximum).');
        const match=avatar.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
        if(!match)throw problem(400,'Utilisez une image PNG, JPG, WebP ou GIF.');
        const b=Buffer.from(match[2],'base64');if(b.length>1024*1024)throw problem(400,'Image trop volumineuse (1 Mo maximum).');
        detectFile(b,`avatar.${match[1]==='jpeg'?'jpg':match[1]}`);values.avatar=avatar;
      }
    }
    if(req.body.preferences!==undefined){if(!req.body.preferences||typeof req.body.preferences!=='object'||Array.isArray(req.body.preferences))throw problem(400,'Préférences invalides.');const prefs=JSON.parse(req.user.preferences);for(const [key,value] of Object.entries(req.body.preferences)){if(!PREF_KEYS.includes(key)||typeof value!=='boolean')throw problem(400,'Préférences invalides.');prefs[key]=value;}values.preferences=JSON.stringify(prefs);}
    const changingPassword=req.body.password!==undefined;
    if(changingPassword){const password=passwordValue(req.body.password,'Nouveau mot de passe');if(password.length<10)throw problem(400,'Le mot de passe doit contenir au moins 10 caractères.');if(!verifyPassword(String(req.body.current_password||''),req.user.password_hash))throw problem(403,'Le mot de passe actuel est incorrect.');values.password_hash=hashPassword(password);}
    transaction(()=>{
      for(const [key,value] of Object.entries(values))db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(value,req.user.id);
      if(changingPassword)db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    });
    if(changingPassword)newSession(req,res,req.user.id);
    if(changingPassword)for(const stream of clients.get(req.user.id)||[])stream.end();
    res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id))});
  });

  app.get('/api/search', requireFaculty, (req,res) => {
    const q=String(req.query.q||'').trim().toLocaleLowerCase().slice(0,180);
    const type=String(req.query.type||'');
    if(type&&!['message','announcement','member','resource',...CATEGORIES].includes(type))throw problem(400,'Type de recherche invalide.');
    const semester=req.query.semester?Number(String(req.query.semester).replace(/^s/i,'')):null;
    if(req.query.semester && (!Number.isInteger(semester)||semester<1||semester>6))throw problem(400,'Semestre invalide.');
    const module=String(req.query.module||'').toLocaleLowerCase();
    const authorFilter=String(req.query.author||'');
    const date=String(req.query.date||'');
    if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date))throw problem(400,'Date invalide.');
    const results=[];
    const matches=(text)=>!q||text.toLocaleLowerCase().includes(q);
    const baseMatches=(row)=>{const a=author(row.author_id||row.id);return (!authorFilter||String(a.id)===authorFilter||a.username===authorFilter)&&(!date||String(row.created_at||'').startsWith(date));};
    if(!type||type==='resource'||CATEGORIES.includes(type))for(const r of db.prepare('SELECT * FROM resources WHERE faculty_id=? AND removed=0 ORDER BY created_at DESC').all(req.user.faculty_id)){
      if(type&&type!=='resource'&&r.category!==type)continue;
      if(semester&&r.semester!==semester||module&&r.module.toLocaleLowerCase()!==module||!baseMatches(r)||!matches(`${r.title} ${r.filename} ${r.module}`))continue;
      results.push({id:r.id,type:r.category,title:r.title,context:`${r.filename} · ${r.module}${r.semester?` · S${r.semester}`:''}`,path:resourcePath(r),author:author(r.author_id),semester:r.semester,module:r.module,date:r.created_at});
    }
    if((!type||type==='message')&&!module)for(const m of db.prepare('SELECT * FROM messages WHERE faculty_id=? AND removed=0 ORDER BY created_at DESC').all(req.user.faculty_id))if(canReadMessage(m,req.user)&&(!semester||m.channel==='filiere'&&m.semester===getChatSemester(semester))&&matches(m.content)&&baseMatches(m))results.push({id:m.id,type:'message',title:m.content.slice(0,100),context:`#${m.channel}${m.channel==='filiere'?` · S${m.semester}/S${m.semester+1}`:''} · ${author(m.author_id).name}`,path:messagePath(m),author:author(m.author_id),semester:m.semester,filiere_id:m.filiere_id,date:m.created_at});
    if((!type||type==='announcement')&&!semester&&!module)for(const a of db.prepare('SELECT * FROM announcements WHERE faculty_id=? ORDER BY created_at DESC').all(req.user.faculty_id))if(canReadAnnouncement(a,req.user)&&matches(a.content)&&baseMatches(a))results.push({id:a.id,type:'announcement',title:a.content.slice(0,100),context:author(a.author_id).name,path:`/app/announcements#announcement-${a.id}`,author:author(a.author_id),date:a.created_at});
    if((!type||type==='member')&&!semester&&!module&&!date)for(const u of db.prepare('SELECT id,name,username,avatar,role FROM users WHERE faculty_id=? AND disabled=0 ORDER BY name').all(req.user.faculty_id))if(matches(`${u.name} ${u.username}`)&&(!authorFilter||String(u.id)===authorFilter||u.username===authorFilter))results.push({id:u.id,type:'member',title:u.name,context:`@${u.username}`,path:`/app/members#member-${u.id}`,author:u});
    res.json({results:results.slice(0,100)});
  });

  app.get('/api/admin', requireFaculty, role('moderator','faculty_admin','global_admin'), (req,res) => {
    const global=req.user.role==='global_admin';
    const where=global?'':' WHERE faculty_id=?';
    const args=global?[]:[req.user.faculty_id];
    res.json({
      users:req.user.role==='moderator'?[]:db.prepare(`SELECT * FROM users${where} ORDER BY name`).all(...args).map(publicUser),
      reports:db.prepare(`SELECT * FROM reports${where} ORDER BY created_at DESC`).all(...args).map(r=>({...r,reporter:author(r.reporter_id)})),
      contacts:req.user.role==='moderator'?[]:db.prepare(`SELECT * FROM contacts${where} ORDER BY created_at DESC`).all(...args),
      faculties:global?db.prepare('SELECT f.*, (SELECT COUNT(*) FROM users u WHERE u.faculty_id=f.id AND u.disabled=0) AS members FROM faculties f').all():[],
      channels:req.user.role==='moderator'?[]:db.prepare(`SELECT * FROM channels${where} ORDER BY faculty_id,id`).all(...args).map(c=>({...c,read_only:!!c.read_only})),
      resources:req.user.role==='moderator'?[]:db.prepare(`SELECT * FROM resources${where}${global?' WHERE':' AND'} removed=0 ORDER BY created_at DESC`).all(...args).map(r=>resource(r)),
    });
  });
  app.post('/api/admin/users', requireFaculty, role('global_admin'), (req,res) => {
    const username=string(req.body.username,'Nom d’utilisateur',40),name=string(req.body.name,'Nom',100),password=passwordValue(req.body.password);
    if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(username))throw problem(400,'Nom d’utilisateur invalide.');
    if(password.length<10)throw problem(400,'Le mot de passe doit contenir au moins 10 caractères.');
    const roleValue=req.body.role||'student',faculty=req.body.faculty_id||null;
    if(!ROLES.includes(roleValue))throw problem(400,'Rôle invalide.');
    if(roleValue!=='student'&&!faculty)throw problem(400,'Attribuez une faculté à ce rôle.');
    if(faculty&&!db.prepare('SELECT 1 FROM faculties WHERE id=?').get(faculty))throw problem(400,'Faculté invalide.');
    if(db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username))throw problem(409,'Ce nom d’utilisateur est déjà utilisé.');
    const id=Number(db.prepare('INSERT INTO users (username,name,password_hash,role,faculty_id) VALUES (?,?,?,?,?)').run(username,name,hashPassword(password),roleValue,faculty).lastInsertRowid);
    res.status(201).json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
  });
  app.patch('/api/admin/channels/:id', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    if(!CHANNELS.includes(req.params.id))throw problem(400,'Discussion invalide.');
    const faculty=req.body.faculty_id||req.user.faculty_id;
    if(req.user.role!=='global_admin'&&faculty!==req.user.faculty_id)throw problem(403,'Vous ne pouvez gérer que les discussions de votre faculté.');
    const channel=db.prepare('SELECT * FROM channels WHERE id=? AND faculty_id=?').get(req.params.id,faculty);
    if(!channel)throw problem(404,'Discussion introuvable.');
    const values={};
    if(req.body.name!==undefined)values.name=string(req.body.name,'Nom de la discussion',80);
    if(req.body.description!==undefined)values.description=string(req.body.description,'Description',500,false);
    if(req.body.read_only!==undefined){if(typeof req.body.read_only!=='boolean')throw problem(400,'État de la discussion invalide.');values.read_only=req.body.read_only?1:0;}
    for(const [key,value]of Object.entries(values))db.prepare(`UPDATE channels SET ${key}=? WHERE id=? AND faculty_id=?`).run(value,channel.id,faculty);
    broadcast(faculty);const updated=db.prepare('SELECT * FROM channels WHERE id=? AND faculty_id=?').get(channel.id,faculty);res.json({channel:{...updated,read_only:!!updated.read_only}});
  });
  app.patch('/api/admin/users/:id', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const target=db.prepare('SELECT * FROM users WHERE id=?').get(asId(req.params.id));
    if(!target)throw problem(404,'Utilisateur introuvable.');
    const global=req.user.role==='global_admin';
    if(!global&&(target.faculty_id!==req.user.faculty_id||!['student','moderator'].includes(target.role)))throw problem(403,'Vous ne pouvez pas gérer ce compte.');
    if(req.body.faculty_id!==undefined&&!global)throw problem(403,'Seul l’administrateur global peut modifier une faculté.');
    if(req.body.role!==undefined&&(!ROLES.includes(req.body.role)||!global&&!['student','moderator'].includes(req.body.role)))throw problem(403,'Rôle non autorisé.');
    if(req.body.disabled!==undefined&&typeof req.body.disabled!=='boolean')throw problem(400,'État du compte invalide.');
    if(target.id===req.user.id&&(req.body.disabled===true||req.body.role&&req.body.role!==target.role))throw problem(400,'Vous ne pouvez pas désactiver ou rétrograder votre propre compte.');
    if(req.body.faculty_id!==undefined&&req.body.faculty_id!==null&&!db.prepare('SELECT 1 FROM faculties WHERE id=?').get(req.body.faculty_id))throw problem(400,'Faculté invalide.');
    transaction(()=>{
      for(const key of ['faculty_id','role','disabled'])if(req.body[key]!==undefined)db.prepare(`UPDATE users SET ${key}=? WHERE id=?`).run(key==='disabled'?(req.body[key]?1:0):req.body[key],target.id);
      if(req.body.faculty_id!==undefined&&!filiereBelongsToFaculty(req.body.faculty_id,target.filiere_id))db.prepare('UPDATE users SET filiere_id=NULL,current_semester=1 WHERE id=?').run(target.id);
      if(req.body.faculty_id!==undefined||req.body.disabled===true||req.body.role!==undefined)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    });
    for(const stream of clients.get(target.id)||[])stream.end();
    broadcast(target.faculty_id);if(req.body.faculty_id)broadcast(req.body.faculty_id);
    res.json({user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
  });
  app.patch('/api/admin/reports/:id', requireFaculty, role('moderator','faculty_admin','global_admin'), (req,res) => {
    const report=db.prepare('SELECT * FROM reports WHERE id=?').get(asId(req.params.id));
    if(!report)throw problem(404,'Signalement introuvable.');
    if(req.user.role!=='global_admin'&&report.faculty_id!==req.user.faculty_id)throw problem(403,'Signalement d’une autre faculté.');
    if(!['open','reviewed','resolved'].includes(req.body.status))throw problem(400,'Statut invalide.');
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(req.body.status,report.id);res.json({ok:true});
  });
  app.patch('/api/admin/contacts/:id', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(asId(req.params.id));
    if(!contact)throw problem(404,'Demande introuvable.');
    if(req.user.role!=='global_admin'&&contact.faculty_id!==req.user.faculty_id)throw problem(403,'Demande d’une autre faculté.');
    if(!['open','resolved'].includes(req.body.status))throw problem(400,'Statut invalide.');
    db.prepare('UPDATE contacts SET status=? WHERE id=?').run(req.body.status,contact.id);
    if(req.body.reply&&contact.user_id&&contact.faculty_id){const reply=string(req.body.reply,'Réponse',4000);db.prepare('INSERT INTO notifications (user_id,faculty_id,type,title,body,path,created_at) VALUES (?,?,?,?,?,?,?)').run(contact.user_id,contact.faculty_id,'admin',`Réponse : ${contact.subject}`,reply,'/app/notifications',now());broadcast(contact.faculty_id);}
    res.json({ok:true});
  });
  app.post('/api/admin/announcements', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const content=string(req.body.content,'Annonce',6000);
    const targets=publicationFaculties(req),announcements=[];
    transaction(()=>{for(const faculty of targets){const id=Number(db.prepare('INSERT INTO announcements (faculty_id,content,channel,author_id,created_at) VALUES (?,?,\'important\',?,?)').run(faculty,content,req.user.id,now()).lastInsertRowid);notify(faculty,'announcements','Nouvelle annonce',content,`/app/announcements#announcement-${id}`,req.user.id);announcements.push(announcement(db.prepare('SELECT * FROM announcements WHERE id=?').get(id)));}});
    targets.forEach(faculty=>broadcast(faculty));res.status(201).json({announcement:announcements[0],announcements});
  });
  app.post('/api/admin/events', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const title=string(req.body.title,'Titre',180),date=string(req.body.date,'Date',10),time=string(req.body.time||'09:00','Horaire',50),type=req.body.type||'event';
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw problem(400,'Date invalide.');
    if(!['exam','rattrapage','deadline','registration','event','defense'].includes(type))throw problem(400,'Type d’événement invalide.');
    const targets=publicationFaculties(req),events=[];
    transaction(()=>{for(const faculty of targets){const id=Number(db.prepare('INSERT INTO events (faculty_id,title,date,time,type) VALUES (?,?,?,?,?)').run(faculty,title,date,time,type).lastInsertRowid);notify(faculty,'calendar','Nouveau rendez-vous',`${title} · ${date}`,`/app/calendar#event-${id}`,req.user.id);events.push({id,title,date,time,type});}});
    targets.forEach(faculty=>broadcast(faculty));res.status(201).json({event:events[0],events});
  });
  app.patch('/api/admin/resources/:id', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const r=db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    const values={};
    if(req.body.title!==undefined)values.title=string(req.body.title,'Titre',180);
    if(req.body.category!==undefined){if(!CATEGORIES.includes(req.body.category))throw problem(400,'Catégorie invalide.');values.category=req.body.category;}
    const category=values.category||r.category;
    const semester=category==='general'?null:Number(req.body.semester??r.semester);
    if(category!=='general'&&(!Number.isInteger(semester)||semester<1||semester>6))throw problem(400,'Semestre invalide.');
    values.semester=semester;
    if(req.body.module!==undefined)values.module=string(req.body.module,'Module',120,false);
    if(req.body.status!==undefined){if(!['new','popular','corrected','updated'].includes(req.body.status))throw problem(400,'Statut invalide.');values.status=req.body.status;}
    transaction(()=>{for(const [key,value]of Object.entries(values))db.prepare(`UPDATE resources SET ${key}=? WHERE id=?`).run(value,r.id);});
    broadcast(r.faculty_id);res.json({resource:resource(db.prepare('SELECT * FROM resources WHERE id=?').get(r.id))});
  });
  app.post('/api/admin/resources/:id/replace', requireFaculty, role('faculty_admin','global_admin'), upload.single('file'), (req,res) => {
    const r=db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    if(!req.file?.size)throw problem(400,'Sélectionnez un fichier.');
    const filename=basename(req.file.originalname).replace(/[\u0000-\u001f]/g,'').slice(0,180);
    const mime=detectFile(req.file.buffer,filename),hash=digest(req.file.buffer);
    if(hash===r.sha256)throw problem(409,'Le fichier est identique à la version actuelle.');
    const duplicate=db.prepare('SELECT * FROM resources WHERE faculty_id=? AND sha256=? AND removed=0 AND id<>?').get(r.faculty_id,hash,r.id);
    if(duplicate)return res.status(409).json({error:'Ce fichier existe déjà dans votre faculté.',resource:resource(duplicate)});
    const stored=randomUUID()+extname(filename).toLowerCase(),filePath=join(dataDir,'files',stored);
    writeFileSync(filePath,req.file.buffer,{mode:0o600});
    try{transaction(()=>{
      const addVersion=db.prepare('INSERT INTO resource_versions (resource_id,version,filename,stored_name,sha256,size,mime,updated_at,editor_id) VALUES (?,?,?,?,?,?,?,?,?)');
      if(!db.prepare('SELECT 1 FROM resource_versions WHERE resource_id=? AND version=?').get(r.id,r.version))addVersion.run(r.id,r.version,r.filename,r.stored_name,r.sha256,r.size,r.mime,r.created_at,r.author_id);
      addVersion.run(r.id,r.version+1,filename,stored,hash,req.file.size,mime,now(),req.user.id);
      db.prepare("UPDATE resources SET filename=?,stored_name=?,sha256=?,size=?,mime=?,version=version+1,status='updated' WHERE id=?").run(filename,stored,hash,req.file.size,mime,r.id);
      notify(r.faculty_id,'resources','Version mise à jour',r.title,resourcePath(r),req.user.id);
    });}catch(e){unlinkSync(filePath);throw e;}
    broadcast(r.faculty_id);res.json({resource:resource(db.prepare('SELECT * FROM resources WHERE id=?').get(r.id))});
  });
  app.delete('/api/admin/resources/:id', requireFaculty, role('faculty_admin','global_admin'), (req,res) => {
    const r=db.prepare('SELECT * FROM resources WHERE id=? AND removed=0').get(asId(req.params.id));
    if(!r)throw problem(404,'Ressource introuvable.');
    if(req.user.role!=='global_admin'&&r.faculty_id!==req.user.faculty_id)throw problem(403,'Ressource d’une autre faculté.');
    transaction(()=>{db.prepare('UPDATE resources SET removed=1 WHERE id=?').run(r.id);db.prepare('UPDATE messages SET resource_id=NULL WHERE resource_id=?').run(r.id);db.prepare('UPDATE announcements SET resource_id=NULL WHERE resource_id=?').run(r.id);});
    broadcast(r.faculty_id);res.json({ok:true});
  });
  app.post('/api/admin/messages/:id/remove', requireFaculty, role('moderator','faculty_admin','global_admin'), (req,res) => {
    const m=req.user.role==='global_admin'?db.prepare('SELECT * FROM messages WHERE id=? AND removed=0').get(asId(req.params.id)):scoped('messages',req.params.id,req,true);
    if(!m)throw problem(404,'Message introuvable.');
    transaction(()=>{db.prepare('UPDATE messages SET removed=1,pinned=0 WHERE id=?').run(m.id);db.prepare('DELETE FROM announcements WHERE message_id=?').run(m.id);});
    broadcast(m.faculty_id);res.json({ok:true});
  });

  app.use('/api', (_req,_res,next)=>next(problem(404,'Route API introuvable.')));
  const dist=resolve('dist');
  if(existsSync(join(dist,'index.html'))){app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(join(dist,'index.html')));}
  app.use((err,_req,res,_next)=>{
    if(res.headersSent)return;
    const status=err instanceof multer.MulterError?400:(err.status||500);
    const message=err instanceof multer.MulterError?(err.code==='LIMIT_FILE_SIZE'?'Le fichier dépasse la limite de 20 Mo.':'Téléversement invalide.'):(err.type==='entity.parse.failed'?'Requête JSON invalide.':status===500?'Une erreur serveur est survenue. Réessayez.':err.message);
    if(status===500)console.error('[CampusLink API]',err.message);
    res.status(status).json({error:message});
  });
  return app;
}
