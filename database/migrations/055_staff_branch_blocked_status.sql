-- Distinguish manual inactive vs branch soft-block
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_status_check;

ALTER TABLE staff
  ADD CONSTRAINT staff_status_check
  CHECK (status IN ('active', 'inactive', 'branch_blocked'));

-- Optional one-time: cannot perfectly recover history.
-- Leave existing inactive as inactive (safe).