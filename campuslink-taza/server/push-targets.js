// Delivery is authorized again after queueing: academic context, content and
// notification preferences may have changed while a device was offline.
export function createPushTargetAuthorizer({db,authorizeNotificationTarget}) {
  const scoped=(row,user)=>!!row&&row.faculty_id===user.faculty_id&&!!user.filiere_id&&row.filiere_id===user.filiere_id;
  const active=user=>user&&!user.disabled&&!user.password_change_required&&user.account_status==='approved';
  return async function canDeliver(user,notice) {
    if(!active(user)||notice.user_id!==user.id||notice.faculty_id!==user.faculty_id)return false;
    const preference=notice.type==='campus'?'mentions':notice.type;
    let preferences;try{preferences=JSON.parse(user.preferences||'{}');}catch{return false;}
    if(preferences[preference]===false||!['resources','questions','mentions','campus'].includes(notice.type))return false;
    if(!await authorizeNotificationTarget(user,notice.path))return false;
    if(notice.type==='resources') {
      const match=/#resource-(\d+)$/.exec(notice.path);if(!match)return false;
      const row=await db.prepare('SELECT * FROM resources WHERE id=?').get(Number(match[1]));
      return scoped(row,user)&&!row.removed&&row.library_visible!==0;
    }
    if(notice.type==='mentions') {
      const match=/#message-(\d+)$/.exec(notice.path);if(!match)return false;
      const row=await db.prepare('SELECT * FROM messages WHERE id=?').get(Number(match[1]));
      if(!row?.reply_to||row.removed||row.author_id===user.id)return false;
      const original=await db.prepare('SELECT * FROM messages WHERE id=?').get(row.reply_to);
      const sender=await db.prepare('SELECT * FROM users WHERE id=?').get(row.author_id);
      return original?.author_id===user.id&&!original.removed&&active(sender)&&sender.faculty_id===row.faculty_id&&
        (row.channel!=='filiere'||sender.filiere_id===row.filiere_id);
    }
    const context=notice.push_context;
    if(!context||!['forum-question','forum-answer','forum-accepted'].includes(context.kind))return false;
    const question=await db.prepare('SELECT * FROM campus_questions WHERE id=?').get(context.questionId);
    if(!scoped(question,user)||question.removed)return false;
    const actor=await db.prepare('SELECT * FROM users WHERE id=?').get(context.actorId);
    if(!active(actor)||!scoped(question,actor)||actor.id===user.id)return false;
    const url=new URL(notice.path,'https://campuslink.invalid');
    if(url.pathname!=='/app/campus'||url.searchParams.get('tab')!=='forum'||Number(url.searchParams.get('question'))!==question.id)return false;
    if(notice.type==='questions')return context.kind==='forum-question'&&question.author_id===actor.id;
    if(notice.type!=='campus'||context.kind==='forum-question')return false;
    const answer=await db.prepare('SELECT * FROM campus_answers WHERE id=?').get(context.answerId);
    if(!answer||answer.removed||answer.question_id!==question.id||Number(url.searchParams.get('answer'))!==answer.id)return false;
    return context.kind==='forum-answer'
      ? question.author_id===user.id&&answer.author_id===actor.id
      : question.author_id===actor.id&&question.accepted_answer_id===answer.id&&answer.author_id===user.id;
  };
}
