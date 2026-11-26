-- Real mailbox for staff whose login ID is not an email (cashiers).
-- Login still uses users.email; this is only where credentials are mailed.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS contact_email TEXT;
