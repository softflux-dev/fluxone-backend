-- Branch opening / closing hours (Phase 1: same-day window only; no overnight)

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS opening_time TIME,
  ADD COLUMN IF NOT EXISTS closing_time TIME;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_hours_pair_check'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_hours_pair_check
      CHECK (
        (opening_time IS NULL AND closing_time IS NULL)
        OR (opening_time IS NOT NULL AND closing_time IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'branches_hours_order_check'
  ) THEN
    ALTER TABLE branches
      ADD CONSTRAINT branches_hours_order_check
      CHECK (
        opening_time IS NULL
        OR closing_time IS NULL
        OR opening_time < closing_time
      );
  END IF;
END $$;
