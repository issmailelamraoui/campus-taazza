-- Reconcile older files that were never linked to a module, or whose link no
-- longer matches their programme/semester. This changes metadata only: no
-- resource, version or stored object is deleted, renamed or moved.
UPDATE resources AS resource
SET module = module.name
FROM modules AS module
WHERE resource.module_id = module.id
  AND trim(normalize(resource.module,NFKC)) = '';

INSERT INTO modules (faculty_id,filiere_id,semester,name)
SELECT DISTINCT ON (
    faculty_id, filiere_id, semester,
    lower(regexp_replace(trim(normalize(module,NFKC)), '\s+', ' ', 'g'))
  ) faculty_id, filiere_id, semester,
    regexp_replace(trim(normalize(module,NFKC)), '\s+', ' ', 'g')
FROM resources
WHERE faculty_id IS NOT NULL AND trim(normalize(module,NFKC)) <> ''
ORDER BY faculty_id, filiere_id, semester,
  lower(regexp_replace(trim(normalize(module,NFKC)), '\s+', ' ', 'g')), id
ON CONFLICT (
  faculty_id, filiere_id, semester,
  lower(regexp_replace(trim(normalize(name,NFKC)), '\s+', ' ', 'g'))
) DO NOTHING;

UPDATE resources AS resource
SET module_id = module.id, module = module.name
FROM modules AS module
WHERE resource.faculty_id = module.faculty_id
  AND resource.filiere_id IS NOT DISTINCT FROM module.filiere_id
  AND resource.semester IS NOT DISTINCT FROM module.semester
  AND lower(regexp_replace(trim(normalize(resource.module,NFKC)), '\s+', ' ', 'g'))
    = lower(regexp_replace(trim(normalize(module.name,NFKC)), '\s+', ' ', 'g'))
  AND (resource.module_id IS DISTINCT FROM module.id
    OR resource.module IS DISTINCT FROM module.name);

CREATE INDEX resources_library_module
  ON resources (faculty_id,filiere_id,semester,module_id)
  WHERE removed = 0 AND library_visible = 1;
