import './env.js';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openDatabase } from './db.js';
import { createAuthService, AuthError } from './auth.js';

// This trusted operator command attaches a proven Neon identity to an EXISTING
// profile. It never takes an application role from provider/browser fields.
const args=new Map();
for(let i=2;i<process.argv.length;i++) {
  const flag=process.argv[i];
  if(flag==='--create')args.set(flag,true);
  else if(['--username','--email','--confirm-role'].includes(flag)&&process.argv[i+1]&&!process.argv[i+1].startsWith('--'))args.set(flag,process.argv[++i]);
  else {process.stderr.write('Use --username, --email, --confirm-role and optional --create. Passwords must be entered privately on stdin.\n');process.exit(1);}
}
if(!args.get('--username')||!args.get('--email')||!args.get('--confirm-role')) {
  process.stderr.write('Usage: node server/link-auth.js --username EXISTING_USERNAME --email REAL_EMAIL --confirm-role EXISTING_ROLE [--create]\n');process.exit(1);
}
let db,proof,created,linked=false;
try {
  db=await openDatabase();
  const profile=await db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(args.get('--username'));
  if(!profile)throw new AuthError(404,'The existing application profile was not found.');
  if(profile.role!==args.get('--confirm-role'))throw new AuthError(400,'The confirmed role must match the existing trusted application role.');
  let muted=true;
  const output=new Writable({write(chunk,_encoding,callback){if(!muted)process.stdout.write(chunk);callback();}});
  const readline=createInterface({input:process.stdin,output,terminal:!!process.stdin.isTTY});
  if(process.stdin.isTTY)process.stdout.write(args.has('--create')?'New Neon password (input hidden): ':'Neon password (input hidden): ');
  const password=await readline.question('');readline.close();muted=false;
  if(process.stdin.isTTY)process.stdout.write('\n');
  if(password.length<10||password.length>256)throw new AuthError(400,'Use a password containing 10 to 256 characters.');
  const auth=createAuthService({db});
  const email=args.get('--email').trim().toLowerCase();
  if(args.has('--create'))created=await auth.createUser({headers:{origin:process.env.APP_ORIGIN||'http://localhost:5173'}},{email,password,name:profile.name});
  proof=await auth.proveIdentity({email,password,requestOrigin:process.env.APP_ORIGIN||'http://localhost:5173'});
  if(proof.authUser.email!==email||created&&created.id!==proof.authUser.id)throw new AuthError(403,'The provider identity did not match the requested account.');
  await db.transaction(async()=>{
    const current=await db.prepare('SELECT * FROM users WHERE id=? FOR UPDATE').get(profile.id);
    if(current.role!==args.get('--confirm-role'))throw new AuthError(409,'The application role changed during linking; retry with the current role.');
    if(current.auth_user_id&&current.auth_user_id!==proof.authUser.id)throw new AuthError(409,'This profile is already linked to another Neon identity.');
    const conflict=await db.prepare('SELECT id FROM users WHERE id<>? AND (auth_user_id=? OR lower(email)=?)').get(current.id,proof.authUser.id,email);
    if(conflict)throw new AuthError(409,'This Neon identity or email is already linked to another application profile.');
    await db.prepare('UPDATE users SET auth_user_id=?,email=?,legacy_password_hash=NULL,auth_revoked_at=NULL WHERE id=?').run(proof.authUser.id,email,current.id);
  });
  linked=true;
  process.stdout.write('Neon identity linked. The existing profile ID, role and academic selections were preserved.\n');
} catch(error) {
  process.stderr.write(`${error instanceof AuthError?error.message:'Account linking failed. Check the server configuration and connection.'}\n`);
  process.exitCode=1;
} finally {
  if(proof)await proof.dispose().catch(()=>{});
  if(created&&!linked) {
    try {await created.cleanup();}
    catch {process.stderr.write('The newly created provider account could not be cleaned up; an operator must review it.\n');process.exitCode=1;}
  }
  if(db)await db.close();
}
