-- Preserve already mapped sessions while requiring explicit backend admission
-- for every new Neon session. No provider accounts or existing users are changed.
CREATE TABLE auth_session_cutover (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO auth_session_cutover(singleton) VALUES(TRUE);
CREATE TABLE auth_legacy_subjects (
  auth_user_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO auth_legacy_subjects(auth_user_id,user_id)
SELECT auth_user_id,id FROM users WHERE auth_user_id IS NOT NULL;
CREATE TABLE google_auth_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auth_user_id TEXT NOT NULL UNIQUE,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  hosted_domain TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE auth_session_admissions (
  session_id TEXT PRIMARY KEY,
  auth_user_id TEXT NOT NULL,
  session_created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('password','google','google_pending')),
  google_sub TEXT,
  provider_email TEXT,
  hosted_domain TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  CHECK(method='password' OR (google_sub IS NOT NULL AND provider_email IS NOT NULL)),
  CHECK(method<>'google' OR user_id IS NOT NULL)
);
CREATE INDEX auth_session_admissions_expiry ON auth_session_admissions(expires_at);
CREATE TABLE google_oauth_attempts (
  token_hash TEXT PRIMARY KEY,
  intent TEXT NOT NULL CHECK(intent IN ('login','link')),
  expires_at TIMESTAMPTZ NOT NULL,
  expected_auth_user_id TEXT,
  expected_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expected_session_id TEXT,
  expected_session_version INTEGER,
  expected_auth_revoked_at TEXT,
  CHECK(intent='login' OR (expected_auth_user_id IS NOT NULL AND expected_user_id IS NOT NULL AND expected_session_id IS NOT NULL))
);
CREATE INDEX google_oauth_attempts_expiry ON google_oauth_attempts(expires_at);
