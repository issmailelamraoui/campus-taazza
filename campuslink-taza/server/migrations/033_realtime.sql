-- Invalidations contain scope identifiers only. Snapshots remain authoritative.
CREATE TABLE realtime_events (
 id BIGSERIAL PRIMARY KEY,
 origin TEXT NOT NULL,
 faculty_id TEXT,
 filiere_id TEXT,
 user_ids JSONB,
 change JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX realtime_events_expiry ON realtime_events(created_at);
CREATE TABLE chat_presence (
 id UUID PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 faculty_id TEXT NOT NULL REFERENCES faculties(id),
 filiere_id TEXT NOT NULL DEFAULT '',
 channel TEXT NOT NULL CHECK(channel IN ('general','important','filiere')),
 semester INTEGER NOT NULL DEFAULT 0,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX chat_presence_scope ON chat_presence(faculty_id,channel,filiere_id,semester,expires_at);
