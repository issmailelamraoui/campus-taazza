CREATE TABLE password_reset_operations (
  operation_id UUID PRIMARY KEY,
  actor_id BIGINT NOT NULL REFERENCES users(id),
  target_user_id BIGINT NOT NULL REFERENCES users(id),
  auth_user_id TEXT NOT NULL,
  contact_id BIGINT REFERENCES contacts(id),
  reason TEXT NOT NULL,
  request_salt TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','issued','changing','failed','unknown','completed','superseded')),
  previous_operation_id UUID REFERENCES password_reset_operations(operation_id),
  previous_required BOOLEAN NOT NULL DEFAULT FALSE,
  previous_expiry TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ
);
CREATE INDEX password_reset_target_time ON password_reset_operations(target_user_id,created_at);
CREATE INDEX password_reset_actor_time ON password_reset_operations(actor_id,created_at);
ALTER TABLE users ADD COLUMN password_change_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN password_reset_operation_id UUID REFERENCES password_reset_operations(operation_id);
ALTER TABLE users ADD COLUMN password_reset_expires_at TIMESTAMPTZ;
