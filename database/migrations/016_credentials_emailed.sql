-- Track whether BM login credentials email was delivered successfully.
-- Key (reset/resend) icon shows only when this is false.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credentials_emailed BOOLEAN NOT NULL DEFAULT false;
