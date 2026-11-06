-- Scoring factors: Enable / Disable (active) without deleting the factor
ALTER TABLE scoring_scales
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_scoring_scales_tenant_active
  ON scoring_scales (tenant_id, is_active);
