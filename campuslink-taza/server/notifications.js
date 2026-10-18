export const NOTIFICATION_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

// The same predicate is used by paging, counters and destination visits. An
// expired row can never reappear while the throttled physical cleanup waits.
const visible = `n.type<>'calendar' AND n.target_deleted=0 AND n.path NOT LIKE '/app/calendar%' AND (
  (n.registration_user_id IS NULL AND n.created_at>=?) OR
  (n.registration_user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM users registration WHERE registration.id=n.registration_user_id AND registration.account_status='pending'
  ))
)`;
const columns = 'n.id,n.type,n.title,n.body,n.path,n.created_at,n.read,n.target_deleted,n.registration_user_id';

export function createNotificationStore({db,decorate,discussionUnread,clock=Date.now}) {
  let cleanedAt=-Infinity,cleanup;
  const cutoff=()=>new Date(clock()-NOTIFICATION_RETENTION_MS).toISOString();
  async function prune() {
    if(cleanup)return cleanup;
    if(clock()-cleanedAt<60000)return;
    cleanup=(async()=>{
      await db.prepare(`DELETE FROM notifications WHERE
        (registration_user_id IS NULL AND created_at<?) OR
        (registration_user_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM users registration WHERE registration.id=notifications.registration_user_id AND registration.account_status='pending'
        ))`).run(cutoff());
      await db.prepare('DELETE FROM notification_visits WHERE expires_at<?').run(new Date(clock()).toISOString());
      cleanedAt=clock();
    })();
    try {await cleanup;} finally {cleanup=undefined;}
  }
  async function rows(user,{limit=200,before=null}={}) {
    await prune();
    return db.prepare(`SELECT ${columns} FROM notifications n WHERE n.user_id=? AND n.faculty_id=? AND ${visible}${before?' AND n.id<?':''} ORDER BY n.id DESC LIMIT ?`)
      .all(user.id,user.faculty_id,cutoff(),...(before?[before]:[]),limit);
  }
  async function find(user,id) {
    await prune();
    return db.prepare(`SELECT ${columns} FROM notifications n WHERE n.id=? AND n.user_id=? AND n.faculty_id=? AND ${visible}`)
      .get(id,user.id,user.faculty_id,cutoff());
  }
  async function payload(user,{limit=200,before=null,notificationRows,context}={}) {
    const [page,unread,discussions]=await Promise.all([
      notificationRows||rows(user,{limit:limit+1,before}),
      db.prepare(`SELECT ${columns} FROM notifications n WHERE n.user_id=? AND n.faculty_id=? AND n.read=0 AND ${visible}`)
        .all(user.id,user.faculty_id,cutoff()),
      discussionUnread?discussionUnread(user):null,
    ]);
    const unique=new Map([...page,...unread].map(row=>[row.id,row]));
    const decorated=await decorate(user,[...unique.values()],context);
    const byId=new Map(decorated.map(row=>[row.id,row]));
    const available=unread.map(row=>byId.get(row.id)).filter(Boolean);
    const hasMore=page.length>limit;
    return {
      notifications:page.slice(0,limit).map(row=>byId.get(row.id)),
      unread_count:available.length,
      discussion_unread_count:discussions?.count??available.filter(row=>/^\/app\/chat\//.test(row.path)).length,
      ...(discussions?{discussion_unread_counts:discussions.channels}:{}),
      admin_unread_count:available.filter(row=>row.popup_eligible).length,
      has_more:hasMore,
      next_before_id:hasMore?page[limit-1].id:null,
    };
  }
  async function markRead(user,id=null) {
    await db.prepare(`UPDATE notifications n SET read=1 WHERE n.user_id=? AND n.faculty_id=? AND n.read=0 AND ${visible}${id===null?'':' AND n.id=?'}`).run(user.id,user.faculty_id,cutoff(),...(id===null?[]:[id]));
  }
  return {rows,find,payload,prune,markRead};
}
