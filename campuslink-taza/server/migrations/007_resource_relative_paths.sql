-- Directory selections still upload individual private objects. This optional
-- display metadata preserves their original folder hierarchy without using any
-- client-supplied path in storage keys or changing existing resource links.
ALTER TABLE resources ADD COLUMN relative_path TEXT NOT NULL DEFAULT '';
