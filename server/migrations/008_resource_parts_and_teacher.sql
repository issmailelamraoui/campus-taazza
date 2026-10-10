-- Academic documents can be ordered inside a module and attributed to
-- the professor/teacher who prepared them. Existing rows remain readable.
ALTER TABLE resources ADD COLUMN part_number INTEGER;
ALTER TABLE resources ADD COLUMN teacher_name TEXT NOT NULL DEFAULT '';

ALTER TABLE resources
  ADD CONSTRAINT resource_part_number_positive
  CHECK (part_number IS NULL OR (part_number >= 1 AND part_number <= 999));

CREATE INDEX resource_module_order
  ON resources(faculty_id,filiere_id,semester,module_id,resource_type,part_number,id);
