-- Join the two semester conversations belonging to the same study year.
-- Updating only the chat scope preserves IDs, replies, pins, reactions, file
-- links, and academic classification in resources/modules/users.
UPDATE messages
SET semester = semester - 1
WHERE channel = 'filiere' AND semester IN (2, 4, 6);
