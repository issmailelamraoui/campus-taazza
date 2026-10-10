-- Apply through the application's migration adapter in its selected schema.
-- Calendar removal is intentional; hidden chat content remains untouched.
DELETE FROM notifications WHERE type = 'calendar' OR path LIKE '/app/calendar%';
DELETE FROM events;

ALTER TABLE users ALTER COLUMN preferences SET DEFAULT
  '{"resources":true,"announcements":true,"important":true,"admin":true,"mentions":true}';
UPDATE users SET preferences = (preferences::jsonb - 'calendar')::text
  WHERE preferences::jsonb ? 'calendar';

-- Keep the oldest module ID and label in each faculty/filiere/semester scope.
-- Stored object names deliberately retain their existing paths and keys.
WITH canonical AS (
  SELECT id,
    first_value(id) OVER (
      PARTITION BY faculty_id, filiere_id, semester,
        lower(regexp_replace(trim(normalize(name,NFKC)), '\s+', ' ', 'g'))
      ORDER BY id
    ) AS canonical_id
  FROM modules
)
UPDATE resources AS resource
SET module_id = canonical.canonical_id, module = module.name
FROM canonical JOIN modules AS module ON module.id = canonical.canonical_id
WHERE resource.module_id = canonical.id;

WITH duplicates AS (
  SELECT id, row_number() OVER (
    PARTITION BY faculty_id, filiere_id, semester,
      lower(regexp_replace(trim(normalize(name,NFKC)), '\s+', ' ', 'g'))
    ORDER BY id
  ) AS position
  FROM modules
)
DELETE FROM modules WHERE id IN (SELECT id FROM duplicates WHERE position > 1);

CREATE UNIQUE INDEX modules_name_normalized ON modules (
  faculty_id, filiere_id, semester,
  lower(regexp_replace(trim(normalize(name,NFKC)), '\s+', ' ', 'g'))
) NULLS NOT DISTINCT;

-- Previously removed content must not leave an actionable report behind.
UPDATE reports SET status = 'resolved',
  note = CASE WHEN note = '' THEN 'Contenu supprimé.' ELSE note END
WHERE status IN ('open','reviewed') AND (
  (target_type = 'message' AND NOT EXISTS (
    SELECT 1 FROM messages WHERE messages.id = reports.target_id AND removed = 0
  )) OR
  (target_type = 'resource' AND NOT EXISTS (
    SELECT 1 FROM resources WHERE resources.id = reports.target_id AND removed = 0
  )) OR
  (target_type = 'announcement' AND NOT EXISTS (
    SELECT 1 FROM announcements WHERE announcements.id = reports.target_id
  ))
);
