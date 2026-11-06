-- Branch Manager (and any user) profile photo for navbar / profile.
-- Staff still use staff.image_url; auth prefers COALESCE(users.image_url, staff.image_url).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS image_url TEXT;
