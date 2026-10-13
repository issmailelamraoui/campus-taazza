-- Explicitly requested, deterministic PDF text extraction. Old versions remain
-- private and are never returned by current-library search.
CREATE TABLE document_text_indexes (
  resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('ready','no_text')),
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 500),
  text_bytes INTEGER NOT NULL CHECK (text_bytes BETWEEN 0 AND 5242880),
  indexed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, document_version)
);
CREATE TABLE document_text_pages (
  resource_id INTEGER NOT NULL,
  document_version INTEGER NOT NULL,
  page INTEGER NOT NULL CHECK (page BETWEEN 1 AND 500),
  text TEXT NOT NULL CHECK (length(text) <= 50000),
  normalized_text TEXT NOT NULL CHECK (length(normalized_text) <= 100000),
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', normalized_text)) STORED,
  PRIMARY KEY (resource_id, document_version, page),
  FOREIGN KEY (resource_id, document_version) REFERENCES document_text_indexes(resource_id, document_version) ON DELETE CASCADE
);
CREATE INDEX document_text_pages_search ON document_text_pages USING GIN(search_vector);
