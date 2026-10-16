-- Bounded private pieces bypass the hosting platform's per-request body limit.
-- The original upload routes still validate and publish the assembled file.
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  faculty_id TEXT NOT NULL REFERENCES faculties(id),
  target_path TEXT NOT NULL,
  fields JSONB NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size>0 AND size<=20971520),
  object_prefix TEXT NOT NULL,
  parts JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','finalizing','complete','failed','cancelled')),
  response_status INTEGER,
  response_body JSONB,
  cleanup_pending INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX upload_sessions_active_owner ON upload_sessions(user_id,expires_at) WHERE state IN ('uploading','finalizing');
CREATE INDEX upload_sessions_cleanup ON upload_sessions(expires_at) WHERE cleanup_pending=1;
