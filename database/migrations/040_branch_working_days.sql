-- Branch working days (Admin sets on create/edit). Future parent of staff.working_days:
-- staff days must be a subset of branch days (enforced in backend, not DB CHECK).
-- Tokens match staff: mon, tue, wed, thu, fri, sat, sun.
-- Default = full week so existing branches stay open until Admin narrows.

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS working_days TEXT[] NOT NULL
    DEFAULT ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_working_days_check'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_working_days_check
      CHECK (
        cardinality(working_days) >= 1
        AND working_days <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]
      );
  END IF;
END $$;

-- Day-set lookups / filters (e.g. working_days && $days)
CREATE INDEX IF NOT EXISTS idx_branches_working_days_gin
  ON branches USING GIN (working_days);
