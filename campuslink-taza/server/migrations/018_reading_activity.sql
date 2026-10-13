-- Reading opportunity is bounded server-side and never proves comprehension.
-- A single user row prevents simultaneous device/document reward sessions.
CREATE TABLE reading_activity_sessions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  token TEXT NOT NULL UNIQUE, resource_id INTEGER NOT NULL REFERENCES resources(id),
  document_version INTEGER NOT NULL CHECK(document_version>0),
  page INTEGER NOT NULL CHECK(page>0), page_count INTEGER NOT NULL CHECK(page_count>0),
  qualified_seconds INTEGER NOT NULL DEFAULT 0 CHECK(qualified_seconds BETWEEN 0 AND 60),
  started_at TEXT NOT NULL, last_ping TEXT NOT NULL, expires_at TEXT NOT NULL,
  CHECK(page<=page_count)
);
CREATE INDEX reading_activity_expiry ON reading_activity_sessions(expires_at);
CREATE INDEX xp_reading_daily ON xp_events(user_id,created_at) WHERE category='reading' AND status='valid';
