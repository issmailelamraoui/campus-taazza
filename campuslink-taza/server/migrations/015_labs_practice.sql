-- Private voluntary parser sessions. No uploaded code is executed or assessed.
CREATE TABLE labs_sessions (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 language TEXT NOT NULL CHECK(language IN ('javascript','json')),
 voluntary_xp BOOLEAN NOT NULL DEFAULT FALSE,
 potential INTEGER NOT NULL DEFAULT 0 CHECK(potential BETWEEN 0 AND 10),
 source TEXT NOT NULL DEFAULT '', last_result JSONB NOT NULL DEFAULT '{}',
 last_source_hash TEXT NOT NULL DEFAULT '', successful_fingerprint TEXT,
 revisions INTEGER NOT NULL DEFAULT 0 CHECK(revisions>=0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_checked_at TEXT,
 completed_at TEXT, rewarded_points INTEGER NOT NULL DEFAULT 0 CHECK(rewarded_points BETWEEN 0 AND 10)
);
CREATE INDEX labs_sessions_owner ON labs_sessions(user_id,updated_at DESC);
CREATE TABLE labs_syntax_errors (
 session_id TEXT NOT NULL REFERENCES labs_sessions(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(session_id,fingerprint)
);
CREATE TABLE labs_rewarded_programs (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES labs_sessions(id), created_at TEXT NOT NULL,
 PRIMARY KEY(user_id,fingerprint)
);
