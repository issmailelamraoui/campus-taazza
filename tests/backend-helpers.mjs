import '../server/env.js';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {openDatabase,createPostgresPool} from '../server/db.js';
import {seedDatabase} from '../server/seed.js';
import {createApp} from '../server/app.js';

const connectionString=process.env.CAMPUS_TEST_DATABASE_URL||process.env.DATABASE_URL;
const failure=(status,message)=>Object.assign(new Error(message),{status});

// Explicit injected storage and identity doubles keep regression suites bounded.
// Application metadata still uses a disposable schema in the real PostgreSQL DB.
export function memoryStorage(){
  const objects=new Map();
  return {
    objects,putCount:0,deleteCount:0,failNextPut:false,failNextDelete:false,
    async put(key,buffer,mime){
      this.putCount++;
      if(this.failNextPut){this.failNextPut=false;throw failure(502,'Le stockage des fichiers est temporairement indisponible. Réessayez.');}
      objects.set(key,{buffer:Buffer.from(buffer),mime});
    },
    async get(key,{range}={}){
      const item=objects.get(key);
      if(!item)throw failure(404,'Fichier indisponible. Signalez-le à l’administration.');
      let buffer=item.buffer,contentRange;
      if(range){
        const match=range.match(/^bytes=(\d*)-(\d*)$/);
        if(!match||!match[1]&&!match[2])throw failure(416,'Plage de fichier invalide.');
        const start=match[1]?Number(match[1]):Math.max(0,buffer.length-Number(match[2]));
        const end=match[1]&&match[2]?Math.min(Number(match[2]),buffer.length-1):buffer.length-1;
        if(start>=buffer.length||start>end)throw failure(416,'Plage de fichier invalide.');
        contentRange=`bytes ${start}-${end}/${buffer.length}`;
        buffer=buffer.subarray(start,end+1);
      }
      return {body:Readable.from(buffer),contentLength:buffer.length,contentType:item.mime,etag:'"test-private-object"',contentRange};
    },
    async head(key){const item=objects.get(key);if(!item)throw failure(404,'Fichier introuvable.');return {contentLength:item.buffer.length,contentType:item.mime};},
    async delete(key){this.deleteCount++;if(this.failNextDelete){this.failNextDelete=false;throw failure(502,'Stockage indisponible.');}objects.delete(key);},
    close(){},
  };
}

export function createTestAuth(initialDb){
  let db=initialDb;
  const identities=new Map(),sessions=new Map();
  const cookieName='campus_neon_test_session';
  const sessionToken=req=>(req.get('cookie')||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const service={
    identities,sessions,
    useDatabase(next){db=next;},
    async bindUser(id,{email,password}={}){
      const user=await db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if(!user)throw new Error('Test profile is missing.');
      const authId=user.auth_user_id||`test-${randomUUID()}`;
      const address=email||user.email||`${user.username}@campuslink.test`;
      await db.prepare('UPDATE users SET auth_user_id=?,email=? WHERE id=?').run(authId,address,id);
      identities.set(authId,{id:authId,email:address,name:user.name,password:password||(user.username==='admin'?'Admin2026!':'Campus2026!')});
      return authId;
    },
    async authenticate(req){
      const stored=sessions.get(sessionToken(req));
      if(!stored||stored.expiresAt<=Date.now())return null;
      const user=await db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(stored.authUserId);
      if(!user||user.disabled||user.auth_revoked_at&&stored.createdAt<=Date.parse(user.auth_revoked_at))return null;
      return {user,authUserId:stored.authUserId,sessionId:stored.id,createdAt:stored.createdAt,expiresAt:stored.expiresAt};
    },
    async signIn(req,res,{email,password,expectedAuthUserId}){
      const identity=identities.get(expectedAuthUserId);
      if(!identity||identity.email!==email||identity.password!==password)throw failure(401,'Nom d’utilisateur ou mot de passe incorrect.');
      const user=await db.prepare('SELECT * FROM users WHERE auth_user_id=?').get(expectedAuthUserId);
      if(!user||user.disabled)throw failure(401,'Nom d’utilisateur ou mot de passe incorrect.');
      const token=randomUUID(),createdAt=Date.now();
      const session={id:token,authUserId:expectedAuthUserId,createdAt,expiresAt:createdAt+30*24*60*60*1000};
      sessions.set(token,session);
      res.cookie(cookieName,token,{httpOnly:true,sameSite:'lax',path:'/',maxAge:30*24*60*60*1000});
      return {user,authUserId:expectedAuthUserId,sessionId:token,createdAt,expiresAt:session.expiresAt};
    },
    async signOut(req,res){sessions.delete(sessionToken(req));res.clearCookie(cookieName,{httpOnly:true,sameSite:'lax',path:'/'});},
    async createUser(_req,{email,password,name}){
      if([...identities.values()].some(identity=>identity.email===email))throw failure(409,'Cette adresse e-mail est déjà utilisée.');
      const id=`test-${randomUUID()}`;
      identities.set(id,{id,email,password,name});
      return {id,email,name,emailVerified:true,cleanup:async()=>{identities.delete(id);}};
    },
    async changePassword(req,res,{currentPassword,newPassword}){
      const identity=identities.get(req.user.auth_user_id);
      if(!identity||identity.password!==currentPassword)throw failure(403,'Le mot de passe actuel est incorrect.');
      identity.password=newPassword;
      for(const [token,session]of sessions)if(session.authUserId===identity.id)sessions.delete(token);
      return service.signIn(req,res,{email:identity.email,password:newPassword,expectedAuthUserId:identity.id});
    },
    async revokeUserSessions(_req,id){
      await db.prepare('UPDATE users SET session_version=session_version+1,auth_revoked_at=? WHERE auth_user_id=?').run(new Date().toISOString(),id);
      for(const [token,session]of sessions)if(session.authUserId===id)sessions.delete(token);
      return {supported:true};
    },
    close(){},
  };
  return service;
}

// Historical regression suites exercise faculty-admin permissions and FLAA
// publication flows. Their explicit compatibility fixture does not alter the
// production seed; new community tests use legacyCommunity:false.
export async function createTestEnvironment({demo=true,storage=memoryStorage(),legacyCommunity=true}={}){
  const schema=`campuslink_test_${randomUUID().replaceAll('-','')}`;
  const db=await openDatabase({connectionString,schema});
  let closed=false;
  async function close(){
    if(closed)return;closed=true;
    await db.close();
    if(!/^campuslink_test_[a-f0-9]{32}$/.test(schema))throw new Error('Refusing to drop a non-test schema.');
    const pool=createPostgresPool({connectionString,max:1});
    try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await pool.end();}
  }
  try{
    await seedDatabase(db,{demo,storage});
    if (demo && legacyCommunity) {
      await db.prepare("UPDATE users SET faculty_id='flaa',filiere_id='french_studies' WHERE username='admin' AND role='global_admin'").run();
      await db.prepare("UPDATE users SET disabled=0,auth_revoked_at=NULL WHERE username='professeure' AND role='faculty_admin' AND name='Ancien membre'").run();
    }
    const auth=createTestAuth(db);
    for(const user of await db.prepare('SELECT id FROM users').all())await auth.bindUser(user.id);
    return {db,auth,storage,schema,close};
  }catch(error){await close();throw error;}
}

export async function createTestApp(options={}){
  const env=await createTestEnvironment(options);
  try{
    const app=await createApp({db:env.db,auth:env.auth,storage:env.storage,appOrigin:options.appOrigin});
    return {...env,app,close:async()=>{await app.locals.close();await env.close();}};
  }catch(error){await env.close();throw error;}
}
