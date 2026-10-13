-- A repair upload stays private until a fresh scoped reviewer publishes it.
-- Terminal records retain reasons and history even after private-file cleanup.
CREATE TABLE document_repairs (
 id UUID PRIMARY KEY, client_id UUID NOT NULL, resource_id INTEGER NOT NULL REFERENCES resources(id),
 author_id INTEGER NOT NULL REFERENCES users(id), faculty_id TEXT NOT NULL REFERENCES faculties(id),
 filiere_id TEXT REFERENCES filieres(id), base_semester INTEGER, base_module TEXT NOT NULL,
 base_version INTEGER NOT NULL CHECK(base_version>0), base_sha256 TEXT NOT NULL CHECK(length(base_sha256)=64),
 base_object_key TEXT NOT NULL, filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 20971520), mime TEXT NOT NULL,
 issue TEXT NOT NULL CHECK(issue IN ('missing_pages','rotated_pages','corrupted','classification','illegible','other')),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 2000),
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','pending','approved','rejected','withdrawn','failed')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), published_version INTEGER CHECK(published_version>0),
 review_reason TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT,
 last_operation UUID, last_operation_actor INTEGER REFERENCES users(id),
 cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE, file_deleted_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(author_id,client_id), FOREIGN KEY(filiere_id,faculty_id) REFERENCES filieres(id,faculty_id),
 CHECK(status<>'approved' OR published_version=base_version+1),
 CHECK(status<>'approved' OR NOT cleanup_pending AND file_deleted_at IS NULL)
);
CREATE INDEX document_repairs_resource ON document_repairs(resource_id,created_at DESC);
CREATE INDEX document_repairs_author ON document_repairs(author_id,created_at DESC);
CREATE INDEX document_repairs_cleanup ON document_repairs(updated_at) WHERE cleanup_pending;
CREATE TABLE document_repair_events (
 id UUID PRIMARY KEY, proposal_id UUID NOT NULL REFERENCES document_repairs(id),
 actor_id INTEGER NOT NULL REFERENCES users(id), administrative BOOLEAN NOT NULL DEFAULT FALSE,
 action TEXT NOT NULL CHECK(action IN ('submitted','ready','approved','rejected','withdrawn','failed')),
 reason TEXT NOT NULL, resource_version INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX document_repair_events_proposal ON document_repair_events(proposal_id,created_at,id);
