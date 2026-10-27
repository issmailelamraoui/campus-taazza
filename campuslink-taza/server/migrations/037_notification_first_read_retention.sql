-- Retention starts when a notification is first read, not when it arrives.
-- The first-read time of historical read rows is unknown. Give those rows one
-- bounded transition window from this migration rather than inventing a time.
ALTER TABLE notifications ADD COLUMN read_at TIMESTAMPTZ;
UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE read=1;

-- Old API instances can still mark read without naming the new column during
-- a rolling restart. Stamp that transition too, and never extend a first read.
CREATE FUNCTION stamp_notification_first_read() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.read=1 THEN
    IF TG_OP='UPDATE' AND OLD.read_at IS NOT NULL THEN
      NEW.read_at=OLD.read_at;
    ELSE
      NEW.read_at=COALESCE(NEW.read_at,CURRENT_TIMESTAMP);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notifications_first_read
  BEFORE INSERT OR UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION stamp_notification_first_read();

DROP INDEX IF EXISTS notifications_expiration;
CREATE INDEX notifications_read_expiration ON notifications(read_at) WHERE read=1;
