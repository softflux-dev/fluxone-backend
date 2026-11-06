ALTER TABLE password_resets
  ADD COLUMN IF NOT EXISTS otp_hash VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;

-- OTP ke waqt token abhi nahi hota, verify ke baad set hota hai
ALTER TABLE password_resets ALTER COLUMN token_hash DROP NOT NULL;