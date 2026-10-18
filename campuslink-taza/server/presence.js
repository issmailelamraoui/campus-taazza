export function installPresence(app,{db,requireFaculty,requireChat,problem,chatScope,broadcast}) {
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 function scope(req){
  const input=req.method==='GET'?req.query:req.body;
  const channel=input.channel||'general';
  if(!['general','important','filiere'].includes(channel))throw problem(400,'Discussion invalide.');
  const scoped=chatScope({...req,body:input},channel);
  return {channel,faculty:req.user.faculty_id,filiere:scoped.filiere_id||'',semester:scoped.semester||0};
 }
 async function list(s){
  const members=await db.prepare(`SELECT DISTINCT u.id,u.username,u.name FROM chat_presence p JOIN users u ON u.id=p.user_id
   WHERE p.faculty_id=? AND p.channel=? AND p.filiere_id=? AND p.semester=? AND p.expires_at>CURRENT_TIMESTAMP
   AND u.disabled=0 AND u.account_status='approved' AND u.faculty_id=p.faculty_id
   AND (p.channel<>'filiere' OR u.filiere_id=p.filiere_id)
   AND NOT EXISTS (SELECT 1 FROM chat_bans b WHERE b.user_id=u.id AND b.faculty_id=p.faculty_id)
   ORDER BY u.username`).all(s.faculty,s.channel,s.filiere,s.semester);
  return {members,count:members.length};
 }
 app.get('/api/presence',requireFaculty,requireChat,async(req,res)=>res.json(await list(scope(req))));
 app.post('/api/presence',requireFaculty,requireChat,async(req,res)=>{
  const s=scope(req),id=String(req.body.client_id||'');
  if(!uuid.test(id))throw problem(400,'Session de discussion invalide.');
  const row=await db.prepare(`INSERT INTO chat_presence(id,user_id,faculty_id,channel,filiere_id,semester,expires_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP+INTERVAL '30 seconds')
   ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE chat_presence.user_id=EXCLUDED.user_id AND chat_presence.faculty_id=EXCLUDED.faculty_id AND chat_presence.channel=EXCLUDED.channel AND chat_presence.filiere_id=EXCLUDED.filiere_id AND chat_presence.semester=EXCLUDED.semester RETURNING id`).get(id,req.user.id,s.faculty,s.channel,s.filiere,s.semester);
  if(!row)throw problem(409,'Session de discussion différente.');
  if(req.body.arriving===true)await broadcast(s.faculty,s.filiere||null);
  res.json(await list(s));
 });
 app.delete('/api/presence/:id',requireFaculty,async(req,res)=>{
  if(!uuid.test(req.params.id))throw problem(400,'Session invalide.');
  const row=await db.prepare('DELETE FROM chat_presence WHERE id=? AND user_id=? RETURNING faculty_id,filiere_id').get(req.params.id,req.user.id);
  if(row)await broadcast(row.faculty_id,row.filiere_id||null);
  res.json({ok:true});
 });
}
