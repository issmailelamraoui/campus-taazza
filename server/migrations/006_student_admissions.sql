-- Existing members and administrator-created accounts keep their access.
-- Only the self-service registration endpoint explicitly creates pending users.
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (account_status IN ('approved','pending','rejected','deleted'));
ALTER TABLE users ADD COLUMN registered_at TEXT;
ALTER TABLE users ADD COLUMN reviewed_at TEXT;
ALTER TABLE users ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
CREATE INDEX users_account_status ON users(account_status);
