ALTER TABLE notifications ADD COLUMN push_eligible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE notifications ADD COLUMN push_context JSONB;

CREATE TABLE push_subscriptions (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash CHAR(64) NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  session_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id,device_id)
);

CREATE TABLE push_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours',
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(notification_id,subscription_id)
);
CREATE INDEX push_outbox_pending ON push_outbox(available_at,id) WHERE state IN ('pending','sending');
CREATE INDEX push_outbox_device_lease ON push_outbox(subscription_id,lease_until) WHERE state='sending';
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- Queue only devices already subscribed when the notice is inserted. The
-- trigger shares the publisher's transaction, including nested upload saves.
-- Capturing the migration's application search_path prevents cross-schema
-- lookups when a later pooled request inserts a qualified notification row.
CREATE FUNCTION queue_notification_web_push() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.push_eligible AND NEW.read=0 AND NEW.target_deleted=0 THEN
    INSERT INTO push_outbox(notification_id,subscription_id)
    SELECT NEW.id,s.id FROM push_subscriptions s JOIN users u ON u.id=s.user_id
    WHERE s.user_id=NEW.user_id AND u.faculty_id=NEW.faculty_id
      AND u.disabled=0 AND u.account_status='approved'
      AND u.session_version=s.session_version
    ON CONFLICT(notification_id,subscription_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notifications_web_push AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION queue_notification_web_push();
