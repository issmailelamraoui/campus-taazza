-- Add real grammar-based syntax checks without enabling code execution or XP
-- for these languages. Existing private sessions retain all their metadata.
ALTER TABLE labs_sessions DROP CONSTRAINT labs_sessions_language_check;
ALTER TABLE labs_sessions ADD CONSTRAINT labs_sessions_language_check
 CHECK(language IN ('javascript','json','python','c','cpp'));
