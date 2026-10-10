CREATE TABLE chat_bans (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  faculty_id TEXT NOT NULL REFERENCES faculties(id),
  blocked_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, faculty_id)
);
CREATE INDEX chat_bans_faculty ON chat_bans(faculty_id);
