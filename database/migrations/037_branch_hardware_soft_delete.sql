-- Soft-delete for branch hardware (directory visibility).
-- access_status remains System Access (active | blocked); is_active = soft remove.

ALTER TABLE branch_hardware
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_branch_hardware_tenant_active
  ON branch_hardware (tenant_id, branch_id, is_active);
