-- Manual private flashcard review scheduling; no XP or generated content.
ALTER TABLE study_tools ADD COLUMN review_due_at TEXT;
ALTER TABLE study_tools ADD COLUMN review_interval_days DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(review_interval_days BETWEEN 0 AND 365);
ALTER TABLE study_tools ADD COLUMN review_ease DOUBLE PRECISION NOT NULL DEFAULT 2.5 CHECK(review_ease BETWEEN 1.3 AND 3);
ALTER TABLE study_tools ADD COLUMN review_repetitions INTEGER NOT NULL DEFAULT 0 CHECK(review_repetitions>=0);
ALTER TABLE study_tools ADD COLUMN review_lapses INTEGER NOT NULL DEFAULT 0 CHECK(review_lapses>=0);
ALTER TABLE study_tools ADD COLUMN review_last_at TEXT;
CREATE INDEX study_flashcard_due ON study_tools(user_id,review_due_at) WHERE kind='flashcard';
CREATE TABLE flashcard_reviews (
 operation_id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 card_id TEXT NOT NULL REFERENCES study_tools(id) ON DELETE CASCADE,
 grade TEXT NOT NULL CHECK(grade IN ('again','hard','good','easy')),
 previous_revision INTEGER NOT NULL CHECK(previous_revision>0),
 due_at TEXT NOT NULL, reviewed_at TEXT NOT NULL
);
CREATE INDEX flashcard_review_owner ON flashcard_reviews(user_id,card_id,reviewed_at DESC);
