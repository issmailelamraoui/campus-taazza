ALTER TABLE contacts ADD COLUMN assigned_to INTEGER REFERENCES users(id);
ALTER TABLE contacts ADD COLUMN accepted_at TEXT;
ALTER TABLE contacts ADD COLUMN closed_at TEXT;
ALTER TABLE contacts ADD COLUMN recovery_hash TEXT UNIQUE;
ALTER TABLE contacts ADD COLUMN client_id UUID UNIQUE;
ALTER TABLE contact_replies ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE contact_replies ADD COLUMN client_id UUID;
CREATE UNIQUE INDEX contact_reply_retry ON contact_replies(contact_id,client_id) WHERE client_id IS NOT NULL;
CREATE TABLE contact_reactions (
 reply_id INTEGER NOT NULL REFERENCES contact_replies(id) ON DELETE CASCADE,
 actor_key TEXT NOT NULL,
 reaction TEXT NOT NULL CHECK(reaction IN ('like','heart')),
 PRIMARY KEY(reply_id,actor_key,reaction)
);
