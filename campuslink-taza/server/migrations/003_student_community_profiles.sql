-- Update the existing owner profile without changing its Neon identity or role.
UPDATE users
SET name='Issmail', faculty_id='fsa', filiere_id='data_science'
WHERE lower(username)='admin' AND role='global_admin';

-- Retire only the professor explicitly present in the original application.
-- Keep the profile row because existing academic resources reference its ID.
UPDATE users
SET name='Ancien membre', disabled=1,
    session_version=session_version+CASE WHEN disabled=0 THEN 1 ELSE 0 END,
    auth_revoked_at=CASE WHEN disabled=0
      THEN to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ELSE auth_revoked_at END
WHERE lower(username)='professeure' AND role='faculty_admin'
  AND name IN ('Pr. Nadia El Idrissi','Ancien membre');

UPDATE messages
SET removed=1, pinned=0
WHERE author_id IN (
  SELECT id FROM users WHERE lower(username)='professeure' AND role='faculty_admin'
    AND name='Ancien membre' AND disabled=1
);

DELETE FROM announcements
WHERE author_id IN (
  SELECT id FROM users WHERE lower(username)='professeure' AND role='faculty_admin'
    AND name='Ancien membre' AND disabled=1
) OR message_id IN (
  SELECT id FROM messages WHERE author_id IN (
    SELECT id FROM users WHERE lower(username)='professeure' AND role='faculty_admin'
      AND name='Ancien membre' AND disabled=1
  )
);

UPDATE resources
SET message_id=NULL
WHERE message_id IN (
  SELECT id FROM messages WHERE author_id IN (
    SELECT id FROM users WHERE lower(username)='professeure' AND role='faculty_admin'
      AND name='Ancien membre' AND disabled=1
  )
);
