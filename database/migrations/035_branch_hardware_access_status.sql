-- System Access block/authorize on BM-created hardware (active | blocked)
ALTER TABLE branch_hardware
  ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'blocked'));

CREATE INDEX IF NOT EXISTS idx_branch_hardware_tenant_access
  ON branch_hardware (tenant_id, access_status);
