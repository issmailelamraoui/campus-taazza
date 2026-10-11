-- Preserve the current CampusLink interface while retaining the imported API.
-- Run this migration in the target application's own schema, never reset the
-- source application's metadata or provider identities.
ALTER TABLE resources DROP CONSTRAINT resource_part_number_positive;
ALTER TABLE resources ALTER COLUMN part_number TYPE TEXT USING part_number::text;
ALTER TABLE resources ADD CONSTRAINT resource_part_number_positive
  CHECK (part_number IS NULL OR part_number = 'complete' OR part_number ~ '^[1-9][0-9]*$');
ALTER TABLE resources ADD COLUMN library_visible INTEGER NOT NULL DEFAULT 1
  CHECK (library_visible IN (0,1));

CREATE TABLE message_attachments (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  resource_id INTEGER NOT NULL UNIQUE REFERENCES resources(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(message_id, resource_id)
);
CREATE INDEX message_attachment_order ON message_attachments(message_id,position);

ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE announcements ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE announcements ADD COLUMN filiere_id TEXT REFERENCES filieres(id);
ALTER TABLE announcements ADD COLUMN kind TEXT NOT NULL DEFAULT 'announcement';
ALTER TABLE reports ADD COLUMN note TEXT NOT NULL DEFAULT '';
