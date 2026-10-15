import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createTestApp} from './backend-helpers.mjs';

const integration=process.env.CAMPUS_TEST_DATABASE_URL?test:test.skip;
let env,server,origin,cookie;
before(async()=>{
  if(!process.env.CAMPUS_TEST_DATABASE_URL)return;
  env=await createTestApp();server=env.app.listen(0,'127.0.0.1');await once(server,'listening');
  origin=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yassine',password:'Campus2026!'})});
  assert.equal(response.status,200);cookie=response.headers.getSetCookie()[0].split(';')[0];
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));await env?.close();});
const request=path=>fetch(origin+path,{headers:{cookie}});

integration('frequent requests preserve the presence timestamp without rewriting the user row',async()=>{
  await request('/api/session');
  const current=()=>env.db.prepare('SELECT last_seen,xmin::text AS revision FROM users WHERE id=3').get();
  const first=await current();
  for(let i=0;i<3;i++)assert.equal((await request('/api/session')).status,200);
  assert.deepEqual(await current(),first,'Presence polling must not write the user row on every request.');
  await env.db.prepare('UPDATE users SET last_seen=? WHERE id=3').run(new Date(Date.now()-120000).toISOString());
  await request('/api/session');
  assert.ok(Date.parse((await current()).last_seen)>Date.now()-5000,'Presence is refreshed once the interval expires.');
});

integration('search hydrates authors and badges in bounded batches as result count grows',async()=>{
  const marker='batch-search-'+randomUUID(),createdAt=new Date().toISOString();
  await env.db.prepare("INSERT INTO messages(faculty_id,channel,content,author_id,created_at) SELECT 'flaa','general',?||n,CASE WHEN n%2=0 THEN 3 ELSE 4 END,? FROM generate_series(1,30) n").run(marker,createdAt);
  const prepare=env.db.prepare.bind(env.db);let profileQueries=0,badgeQueries=0;
  env.db.prepare=sql=>{if(sql.startsWith('SELECT id,name,username,avatar,account_status FROM users'))profileQueries++;if(sql.includes('COUNT(DISTINCT r.requester_id) AS requesters'))badgeQueries++;return prepare(sql);};
  try{
    const response=await request('/api/search?type=message&q='+marker),data=await response.json();
    assert.equal(response.status,200);assert.equal(data.results.length,30);
    assert.ok(data.results.every(row=>[3,4].includes(row.author.id)));
    assert.equal(profileQueries,1,'Thirty messages need one bulk profile read.');
    assert.equal(badgeQueries,1,'Badges are read once for all matching authors.');
  }finally{env.db.prepare=prepare;}
});

integration('unknown API paths return a JSON 404 while application routes keep working',async()=>{
  const response=await request('/api/does-not-exist');
  assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/application\/json/);
  assert.deepEqual(await response.json(),{error:'Route API introuvable.'});
  assert.equal((await request('/api/session')).status,200);
});

integration('simultaneous contact submissions cannot exceed the eight-request allowance',async()=>{
  const marker='contact-reservation-'+randomUUID();
  const responses=await Promise.all(Array.from({length:10},()=>fetch(origin+'/api/contact',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({subject:marker,message:'A controlled contact rate regression.'})})));
  assert.deepEqual(responses.map(response=>response.status).sort(),[201,201,201,201,201,201,201,201,429,429]);
  assert.ok(responses.filter(response=>response.status===429).every(response=>Number(response.headers.get('retry-after'))>0));
  const row=await env.db.prepare('SELECT COUNT(*)::integer AS total FROM contacts WHERE subject=?').get(marker);
  assert.equal(row.total,8);
});
