UPDATE users
SET role = 'MASTER'
WHERE id = (
  SELECT id
  FROM users
  WHERE active = TRUE
  ORDER BY created_at ASC, id ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM users
  WHERE role = 'MASTER' AND active = TRUE
);
