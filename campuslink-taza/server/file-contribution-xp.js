// File rewards are ledger entries, not a counter on the resource. The byte
// fingerprint survives removal, replacement and report decisions permanently.
export const FILE_CONTRIBUTION_EVIDENCE = 'published_library_file';
export const FILE_CONTRIBUTION_POLICY = Object.freeze({ points_per_file: 5, daily_cap: 25, timezone: 'Africa/Casablanca', confirmation_required_for_revocation: true });
export const fileContributionKey = hash => `resource-upload:${hash}`;

export async function awardFileContribution(db, resourceId) {
  const resource = await db.prepare('SELECT * FROM resources WHERE id=?').get(resourceId);
  if (!resource || resource.removed || resource.library_visible !== 1 || !resource.object_key || resource.size <= 0 || !/^[a-f0-9]{64}$/.test(resource.sha256 || '')) return 0;
  const snapshot = await db.prepare('SELECT faculty_id,filiere_id FROM users WHERE id=?').get(resource.author_id);
  if (!snapshot) return 0;
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${snapshot.faculty_id}:${snapshot.filiere_id}`);
  const actor = await db.prepare('SELECT * FROM users WHERE id=? FOR SHARE').get(resource.author_id);
  if (!actor || actor.disabled || actor.account_status !== 'approved' || !actor.faculty_id || !actor.filiere_id || !['student','faculty_leader'].includes(actor.role)
    || actor.faculty_id !== snapshot.faculty_id || actor.filiere_id !== snapshot.filiere_id
    || actor.faculty_id !== resource.faculty_id || actor.filiere_id !== resource.filiere_id
    || await db.prepare('SELECT 1 FROM platform_owner WHERE user_id=?').get(actor.id)) return 0;
  const key = fileContributionKey(resource.sha256);
  if (await db.prepare('SELECT 1 FROM xp_events WHERE user_id=? AND event_key=?').get(actor.id,key)) return 0;
  // A file published after the daily limit received no XP event. Its earlier
  // public metadata still prevents deleting/reuploading it for tomorrow's XP.
  if (await db.prepare(`SELECT 1 FROM resources WHERE author_id=? AND sha256=? AND library_visible=1 AND id<?
    UNION ALL SELECT 1 FROM resource_versions v JOIN resources r ON r.id=v.resource_id
      WHERE r.author_id=? AND v.sha256=? AND r.library_visible=1 AND r.id<? LIMIT 1`).get(actor.id,resource.sha256,resource.id,actor.id,resource.sha256,resource.id)) return 0;
  const awardedAt = new Date().toISOString();
  // A revoked award still consumes its original day's budget. Confirmation of
  // one bad file must not create a fresh allowance for the same day's spam.
  const daily = await db.prepare(`SELECT COALESCE(SUM(points),0)::integer AS points FROM xp_events
    WHERE user_id=? AND category='contribution' AND details->>'evidence'=?
      AND (created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date=(?::timestamptz AT TIME ZONE 'Africa/Casablanca')::date`).get(actor.id,FILE_CONTRIBUTION_EVIDENCE,awardedAt);
  const points = Math.min(FILE_CONTRIBUTION_POLICY.points_per_file,FILE_CONTRIBUTION_POLICY.daily_cap - daily.points);
  if (points <= 0) return 0;
  const event = await db.prepare(`INSERT INTO xp_events(user_id,category,event_key,points,details,created_at)
    VALUES(?,'contribution',?,?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING RETURNING id`).get(actor.id,key,points,
    JSON.stringify({resource_id:resource.id,sha256:resource.sha256,faculty_id:resource.faculty_id,filiere_id:resource.filiere_id,evidence:FILE_CONTRIBUTION_EVIDENCE,policy_version:1,not_quality_proof:true}),awardedAt);
  return event ? points : 0;
}

export async function revokeFileContribution(db, resource, {actorId=null,reason='resource_removed',reportId=null}={}) {
  const snapshot = await db.prepare('SELECT faculty_id,filiere_id FROM users WHERE id=?').get(resource.author_id);
  if (!snapshot) return 0;
  await db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(`campuslink:xp-ranking:${snapshot.faculty_id}:${snapshot.filiere_id}`);
  const current = await db.prepare('SELECT faculty_id,filiere_id FROM users WHERE id=? FOR SHARE').get(resource.author_id);
  if (!current || current.faculty_id !== snapshot.faculty_id || current.filiere_id !== snapshot.filiere_id) throw Object.assign(new Error('Le compte a changé de filière. Rechargez avant de confirmer cette décision.'),{status:409});
  // Resource id remains authoritative even if an administrator replaced its
  // bytes; changing the current hash cannot hide the original credited event.
  const revoked = await db.prepare(`UPDATE xp_events SET status='revoked',details=details||?::jsonb
    WHERE user_id=? AND category='contribution' AND status='valid' AND details->>'evidence'=?
      AND details->>'resource_id'=? RETURNING points`).all(JSON.stringify({revoked_by:actorId,revocation_reason:reason,report_id:reportId,revoked_at:new Date().toISOString()}),resource.author_id,FILE_CONTRIBUTION_EVIDENCE,String(resource.id));
  return revoked.reduce((total,event)=>total+event.points,0);
}

export async function fileContributionSummary(db,userId) {
  const row = await db.prepare(`SELECT COUNT(*) FILTER(WHERE status='valid')::integer AS files,
      COALESCE(SUM(points) FILTER(WHERE status='valid'),0)::integer AS points,
      COALESCE(SUM(points) FILTER(WHERE (created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date=(now() AT TIME ZONE 'Africa/Casablanca')::date),0)::integer AS today_awarded
    FROM xp_events WHERE user_id=? AND category='contribution' AND details->>'evidence'=?`).get(userId,FILE_CONTRIBUTION_EVIDENCE);
  return {...row,today_remaining:Math.max(0,FILE_CONTRIBUTION_POLICY.daily_cap-row.today_awarded)};
}
