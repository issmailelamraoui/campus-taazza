-- Directional blocks are private to their owner. Pair operations serialize on
-- the same advisory lock before request/room rows, so a committed block also
-- prevents concurrent acceptance and messaging.
CREATE TABLE campus_blocks (
 blocker_id INTEGER NOT NULL REFERENCES users(id),
 blocked_id INTEGER NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 CHECK(blocker_id<>blocked_id), PRIMARY KEY(blocker_id,blocked_id)
);
CREATE INDEX campus_blocks_recipient ON campus_blocks(blocked_id,blocker_id);

-- Abandoned open requests expire after seven days. Read/accept/create endpoints
-- durably close them; no conversation or report is removed by this cleanup.
ALTER TABLE close_requests ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+INTERVAL '7 days');
UPDATE close_requests SET expires_at=created_at::timestamptz+INTERVAL '7 days';
ALTER TABLE close_requests ADD COLUMN close_reason TEXT CHECK(close_reason IN ('expired','cancelled','room_closed','blocked'));
CREATE INDEX close_request_expiration ON close_requests(expires_at) WHERE status='open';
