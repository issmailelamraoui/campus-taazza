-- Additive private study data. Source versions stay stable when files are replaced.
CREATE TABLE reading_positions (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 document_version INTEGER NOT NULL CHECK(document_version>0),
 page INTEGER NOT NULL DEFAULT 1 CHECK(page BETWEEN 1 AND 100000),
 scroll_ratio DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(scroll_ratio BETWEEN 0 AND 1),
 zoom DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(zoom BETWEEN 0.4 AND 3),
 preferences TEXT NOT NULL DEFAULT '{"tone":"normal","brightness":1}',
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 device_id TEXT NOT NULL DEFAULT '', operation_id TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,resource_id,document_version)
);
CREATE INDEX reading_recent ON reading_positions(user_id,updated_at DESC);
CREATE TABLE reading_position_conflicts (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 document_version INTEGER NOT NULL, device_id TEXT NOT NULL, position TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,resource_id,document_version,device_id)
);
CREATE TABLE knowledge_items (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 resource_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
 document_version INTEGER, page INTEGER CHECK(page BETWEEN 1 AND 100000),
 kind TEXT NOT NULL CHECK(kind IN ('note','highlight','reference','excerpt','region')),
 title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', selected_text TEXT NOT NULL DEFAULT '',
 anchor TEXT NOT NULL DEFAULT '[]', image_data TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL DEFAULT 'yellow' CHECK(color IN ('yellow','blue','pink','green')),
 tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_owner_updated ON knowledge_items(user_id,updated_at DESC);
CREATE INDEX knowledge_document ON knowledge_items(user_id,resource_id,document_version,page);
CREATE TABLE study_tools (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('flashcard','checklist','collection')),
 title TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX study_tools_owner ON study_tools(user_id,kind,updated_at DESC);
