-- Migration 028: Holiday Schedule table with date ranges, employee assignments, and status
CREATE TABLE IF NOT EXISTS holiday_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_all_employees BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS holiday_schedule_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  holiday_schedule_id UUID NOT NULL REFERENCES holiday_schedules(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, holiday_schedule_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_holiday_schedules_tenant ON holiday_schedules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_holiday_schedules_branch ON holiday_schedules(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_holiday_schedule_staff_sched ON holiday_schedule_staff(holiday_schedule_id);

-- Backfill from existing holidays table if any exist
INSERT INTO holiday_schedules (tenant_id, name, start_date, end_date, is_all_employees, status)
SELECT h.tenant_id, h.name, h.holiday_date, h.holiday_date, true, 'active'
FROM holidays h
WHERE NOT EXISTS (
  SELECT 1 FROM holiday_schedules hs
  WHERE hs.tenant_id = h.tenant_id AND hs.name = h.name AND hs.start_date = h.holiday_date
);
