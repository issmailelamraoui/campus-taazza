CREATE TABLE resource_supplements (
  main_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  supplement_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  linked_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  CHECK(main_resource_id<>supplement_resource_id),
  PRIMARY KEY(main_resource_id,supplement_resource_id)
);
CREATE INDEX resource_supplements_child ON resource_supplements(supplement_resource_id);
