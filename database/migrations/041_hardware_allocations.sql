-- Hardware allocations: schedule-aware assignments separate from staff row.
-- IM (exclusive): device fully locked — no other staff may use it.
-- Cashier (shared): same device OK for multiple cashiers when day+time do not overlap.
-- staff.hardware_device_id remains a denormalized pointer for list UI / legacy reads.

CREATE TABLE IF NOT EXISTS hardware_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  hardware_id UUID NOT NULL REFERENCES branch_hardware(id) ON DELETE RESTRICT,
  working_days TEXT[] NOT NULL DEFAULT '{}',
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  -- exclusive = IM lock; shared = cashier shift share; optional = phase-2 soft assign
  mode TEXT NOT NULL CHECK (mode IN ('exclusive', 'shared', 'optional')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hardware_allocations_days_check
    CHECK (working_days <@ ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']::text[]),
  CONSTRAINT hardware_allocations_time_check
    CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_hw_alloc_tenant_branch_hw
  ON hardware_allocations (tenant_id, branch_id, hardware_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hw_alloc_staff_active
  ON hardware_allocations (tenant_id, staff_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hw_alloc_working_days_gin
  ON hardware_allocations USING GIN (working_days)
  WHERE status = 'active';

-- At most one active exclusive lock per device (IM).
CREATE UNIQUE INDEX IF NOT EXISTS uq_hw_alloc_exclusive_device
  ON hardware_allocations (tenant_id, hardware_id)
  WHERE status = 'active' AND mode = 'exclusive';

-- Backfill from legacy staff.hardware_device_id + schedule.
INSERT INTO hardware_allocations (
  tenant_id, branch_id, staff_id, hardware_id,
  working_days, start_time, end_time, mode, status
)
SELECT
  s.tenant_id,
  s.branch_id,
  s.id,
  h.id,
  COALESCE(s.working_days, ARRAY[]::text[]),
  COALESCE(s.schedule_start, TIME '00:00'),
  COALESCE(s.schedule_end, TIME '23:59'),
  CASE
    WHEN r.slug = 'inventory_manager' THEN 'exclusive'
    WHEN r.slug = 'cashier' THEN 'shared'
    ELSE 'optional'
  END,
  'active'
FROM staff s
JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
JOIN roles r ON r.id = u.role_id
JOIN branch_hardware h
  ON h.tenant_id = s.tenant_id
 AND h.id::text = NULLIF(btrim(s.hardware_device_id), '')
WHERE s.hardware_device_id IS NOT NULL
  AND btrim(s.hardware_device_id) <> ''
  AND s.status NOT IN ('inactive', 'blocked')
  AND COALESCE(array_length(s.working_days, 1), 0) > 0
  AND s.schedule_start IS NOT NULL
  AND s.schedule_end IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM hardware_allocations a
    WHERE a.tenant_id = s.tenant_id
      AND a.staff_id = s.id
      AND a.status = 'active'
  );
