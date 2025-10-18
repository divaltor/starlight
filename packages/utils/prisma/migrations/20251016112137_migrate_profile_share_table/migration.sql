-- This is an empty migration.
UPDATE users SET is_public = true WHERE id in (SELECT user_id FROM profile_shares);