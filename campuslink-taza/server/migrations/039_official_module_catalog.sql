-- Add verification metadata without promoting or reassigning any historical
-- module. Administrators must cite a verified curriculum before publication.
ALTER TABLE modules ADD COLUMN catalog_status TEXT NOT NULL DEFAULT 'legacy'
  CHECK (catalog_status IN ('legacy','official'));
ALTER TABLE modules ADD COLUMN catalog_key TEXT;
ALTER TABLE modules ADD COLUMN curriculum_source TEXT NOT NULL DEFAULT '';
ALTER TABLE modules ADD COLUMN verified_by BIGINT REFERENCES users(id);
ALTER TABLE modules ADD COLUMN verified_at TEXT;
ALTER TABLE modules ADD CONSTRAINT modules_official_verification CHECK (
  catalog_status <> 'official' OR (
    catalog_key IS NOT NULL AND trim(catalog_key) <> ''
    AND trim(curriculum_source) <> '' AND verified_by IS NOT NULL
    AND verified_at IS NOT NULL AND filiere_id IS NOT NULL AND semester IS NOT NULL
  )
);
CREATE UNIQUE INDEX modules_official_catalog_identity
  ON modules (faculty_id,filiere_id,semester,catalog_key) NULLS NOT DISTINCT
  WHERE catalog_status='official';
