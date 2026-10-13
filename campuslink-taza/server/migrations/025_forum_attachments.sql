CREATE TABLE forum_attachments (
 id UUID PRIMARY KEY,
 question_id INTEGER NOT NULL REFERENCES campus_questions(id),
 author_id INTEGER NOT NULL REFERENCES users(id),
 client_id UUID NOT NULL,
 filename TEXT NOT NULL,
 object_key TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size>0 AND size<=20971520),
 mime TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN('uploading','ready','removed','failed')),
 cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
 file_deleted_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(author_id,client_id)
);
CREATE INDEX forum_attachment_question ON forum_attachments(question_id,status,created_at);
CREATE INDEX forum_attachment_quota ON forum_attachments(author_id,status,created_at);
