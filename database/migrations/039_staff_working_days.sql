-- Staff working days for hardware availability (shift + days overlap).
-- Allowed tokens: mon, tue, wed, thu, fri, sat, sun.
-- Existing columns already cover the rest of Phase 1:
--   staff.schedule_start / schedule_end
--   staff.hardware_device_id
--   branches.opening_time / closing_time
--   branch_hardware.type / is_active

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS working_days TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_working_days_check'
  ) THEN
    ALTER TABLE staff
      ADD CONSTRAINT staff_working_days_check
      CHECK (
        working_days <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]
      );
  END IF;
END $$;

-- Day-set overlap lookups: working_days && $days
CREATE INDEX IF NOT EXISTS idx_staff_working_days_gin
  ON staff USING GIN (working_days);

-- Find staff assigned to a device within a branch (conflict / availability)
CREATE INDEX IF NOT EXISTS idx_staff_hardware_device
  ON staff (tenant_id, branch_id, hardware_device_id)
  WHERE hardware_device_id IS NOT NULL AND btrim(hardware_device_id) <> '';
