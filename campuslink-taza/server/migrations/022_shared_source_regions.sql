-- Explicit source selections store normalized coordinates, never copied private
-- raster data. Recipients still require current access to the source document.
ALTER TABLE campus_questions ADD COLUMN source_anchor JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_anchor)='array' AND jsonb_array_length(source_anchor)<=100);
ALTER TABLE close_requests ADD COLUMN source_anchor JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(source_anchor)='array' AND jsonb_array_length(source_anchor)<=100);
ALTER TABLE campus_questions ADD COLUMN source_excerpt TEXT NOT NULL DEFAULT '' CHECK(length(source_excerpt)<=2000);
