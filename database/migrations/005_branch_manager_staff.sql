-- Branch Manager: designations master + staff schedule/status/image fields

CREATE TABLE IF NOT EXISTS designations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_designations_tenant ON designations(tenant_id);

ALTER TABLE staff ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS designation_id UUID REFERENCES designations(id) ON DELETE SET NULL;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule_start TIME;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule_break_start TIME;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule_break_end TIME;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule_end TIME;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_status_check'
  ) THEN
    ALTER TABLE staff
      ADD CONSTRAINT staff_status_check
      CHECK (status IN ('open', 'blocked'));
  END IF;
END $$;

UPDATE staff
SET joined_at = created_at
WHERE joined_at IS NULL;

-- Backfill designations from legacy free-text designation values
INSERT INTO designations (tenant_id, name)
SELECT DISTINCT s.tenant_id, trim(s.designation)
FROM staff s
WHERE s.designation IS NOT NULL
  AND trim(s.designation) <> ''
ON CONFLICT (tenant_id, name) DO NOTHING;

UPDATE staff s
SET designation_id = d.id
FROM designations d
WHERE s.tenant_id = d.tenant_id
  AND s.designation_id IS NULL
  AND s.designation IS NOT NULL
  AND trim(s.designation) = d.name;

CREATE INDEX IF NOT EXISTS idx_staff_designation ON staff(designation_id);
CREATE INDEX IF NOT EXISTS idx_staff_status ON staff(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_staff_branch ON staff(tenant_id, branch_id);
