-- Module references do not duplicate, republish or change access to library files.
-- Keep their original label even when the last document is later removed.
CREATE TABLE message_module_shares (
  message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  resource_id BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  faculty_id TEXT NOT NULL REFERENCES faculties(id),
  filiere_id TEXT NOT NULL REFERENCES filieres(id),
  semester INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 6),
  module TEXT NOT NULL
);
