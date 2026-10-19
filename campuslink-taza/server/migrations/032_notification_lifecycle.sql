ALTER TABLE notifications ADD COLUMN registration_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- Legacy registration notices had no stable target. Rebuild them from pending
-- requests rather than matching names, which are neither unique nor immutable.
DELETE FROM notifications WHERE title='Nouvelle demande d’inscription'
  AND path IN ('/app/admin?tab=registrations','/app/admin?tab=admissions');
INSERT INTO notifications(user_id,faculty_id,type,title,body,path,created_at,registration_user_id)
SELECT owner.id,owner.faculty_id,'admin','Nouvelle demande d’inscription',request.name,
  '/app/admin?tab=registrations&registration='||request.id||'#registration-'||request.id,
  COALESCE(request.registered_at,CURRENT_TIMESTAMP::text),request.id
FROM users request CROSS JOIN platform_owner binding JOIN users owner ON owner.id=binding.user_id
WHERE request.account_status='pending' AND request.role='student'
  AND owner.faculty_id IS NOT NULL AND owner.disabled=0 AND owner.account_status='approved'
  AND COALESCE(owner.preferences::jsonb->>'admin','true')<>'false';

CREATE INDEX notifications_owner_page ON notifications(user_id,faculty_id,id DESC);
CREATE INDEX notifications_owner_unread ON notifications(user_id,faculty_id,id DESC) WHERE read=0 AND target_deleted=0;
CREATE INDEX notifications_expiration ON notifications(created_at) WHERE registration_user_id IS NULL;
CREATE INDEX notifications_registration ON notifications(registration_user_id) WHERE registration_user_id IS NOT NULL;
CREATE INDEX notification_visits_expiration ON notification_visits(expires_at);
CREATE INDEX notification_visits_target ON notification_visits(notification_id);

CREATE TABLE discussion_reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  faculty_id TEXT NOT NULL REFERENCES faculties(id),
  channel TEXT NOT NULL CHECK(channel IN ('general','important','filiere')),
  filiere_id TEXT NOT NULL DEFAULT '',
  semester INTEGER NOT NULL DEFAULT 0,
  last_read_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,faculty_id,channel,filiere_id,semester),
  CHECK((channel='filiere' AND semester BETWEEN 1 AND 6 AND filiere_id<>'') OR (channel<>'filiere' AND semester=0 AND filiere_id=''))
);
-- Bound badge scans to recent faculty traffic even when an account has never
-- opened a discussion. The existing message_studies index covers chat scope.
CREATE INDEX messages_unread_recent ON messages(faculty_id,created_at,id) WHERE removed=0;
