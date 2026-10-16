-- Preserve the original byte identity and credited resource through replacement
-- and removal. Existing reading, help, forum and practice events are untouched.
CREATE INDEX IF NOT EXISTS xp_file_contribution_resource ON xp_events(user_id,(details->>'resource_id'))
  WHERE category='contribution' AND details->>'evidence'='published_library_file';
CREATE INDEX IF NOT EXISTS resources_upload_fingerprint ON resources(author_id,sha256,id) WHERE library_visible=1;
CREATE INDEX IF NOT EXISTS resource_versions_upload_fingerprint ON resource_versions(sha256,resource_id);

-- Credit existing legitimate library contributions once, using their original
-- Casablanca publication day, not today's allowance. A confirmed report or a
-- replacement excludes a file from this conservative historical backfill.
WITH distinct_files AS (
  SELECT DISTINCT ON(r.author_id,r.sha256) r.*,
    (r.created_at::timestamptz AT TIME ZONE 'Africa/Casablanca')::date AS award_day
  FROM resources r JOIN users u ON u.id=r.author_id
  WHERE r.removed=0 AND r.library_visible=1 AND r.version=1 AND r.size>0 AND r.object_key<>''
    AND r.sha256 ~ '^[a-f0-9]{64}$' AND r.faculty_id=u.faculty_id AND r.filiere_id=u.filiere_id
    AND u.role IN('student','faculty_leader') AND u.disabled=0 AND u.account_status='approved'
    AND NOT EXISTS(SELECT 1 FROM platform_owner o WHERE o.user_id=u.id)
    AND NOT EXISTS(SELECT 1 FROM reports p WHERE p.target_type='resource' AND p.target_id=r.id AND p.status='resolved')
  ORDER BY r.author_id,r.sha256,r.created_at,r.id
), budgeted AS (
  SELECT r.*,ROW_NUMBER() OVER(PARTITION BY author_id,award_day ORDER BY created_at,id) AS daily_number
  FROM distinct_files r
)
INSERT INTO xp_events(user_id,category,event_key,points,details,created_at)
SELECT author_id,'contribution','resource-upload:'||sha256,5,
  jsonb_build_object('resource_id',id,'sha256',sha256,'faculty_id',faculty_id,'filiere_id',filiere_id,
    'evidence','published_library_file','policy_version',1,'historical_backfill',true,'not_quality_proof',true),created_at
FROM budgeted WHERE daily_number<=5
ON CONFLICT(user_id,event_key) DO NOTHING;
