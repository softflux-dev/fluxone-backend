-- B2B Admin Manage Branches: branch profile fields + BM contact profile on users

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_status_check'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_status_check
      CHECK (status IN ('open', 'blocked'));
  END IF;
END $$;

UPDATE branches SET status = 'open' WHERE status IS NULL OR status = '';

CREATE INDEX IF NOT EXISTS idx_branches_tenant_status
  ON branches (tenant_id, status);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS other_phone TEXT;
