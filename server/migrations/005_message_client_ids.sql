ALTER TABLE messages ADD COLUMN client_id UUID;

-- A deleted message retains its key, so retry cannot recreate it. Old messages
-- and callers without a key remain valid.
CREATE UNIQUE INDEX messages_author_client_id ON messages (author_id,client_id)
WHERE client_id IS NOT NULL;
