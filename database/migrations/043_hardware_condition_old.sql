-- Allow Device Condition value "Old" (UI synonym for legacy "Used").
ALTER TABLE branch_hardware
  DROP CONSTRAINT IF EXISTS branch_hardware_status_check;

ALTER TABLE branch_hardware
  ADD CONSTRAINT branch_hardware_status_check
  CHECK (status IN ('New', 'Used', 'Old', 'Good', 'Poor'));
