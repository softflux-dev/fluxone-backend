-- Dual leave flow:
--   staff            → BM appoints leave for employees (auto-approved)
--   branch_manager   → BM self-request (pending until Admin decides)

-- Staff leaves keep staff_id; BM self-leaves leave staff_id NULL
ALTER TABLE leaves
  ALTER COLUMN staff_id DROP NOT NULL;

ALTER TABLE leaves
  ADD COLUMN IF NOT EXISTS leave_for TEXT NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- Existing rows are staff appointments — fill branch from staff roster
UPDATE leaves l
SET branch_id = s.branch_id
FROM staff s
WHERE l.staff_id = s.id
  AND l.branch_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leaves_leave_for_check'
  ) THEN
    ALTER TABLE leaves
      ADD CONSTRAINT leaves_leave_for_check
      CHECK (leave_for IN ('staff', 'branch_manager'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leaves_target_check'
  ) THEN
    ALTER TABLE leaves
      ADD CONSTRAINT leaves_target_check
      CHECK (
        (leave_for = 'staff' AND staff_id IS NOT NULL)
        OR (
          leave_for = 'branch_manager'
          AND staff_id IS NULL
          AND requested_by IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leaves_tenant_branch
  ON leaves (tenant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_leaves_tenant_leave_for_status
  ON leaves (tenant_id, leave_for, status);

CREATE INDEX IF NOT EXISTS idx_leaves_requested_by
  ON leaves (tenant_id, requested_by);
