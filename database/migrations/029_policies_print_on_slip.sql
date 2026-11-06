-- Policies: optional print-on-slip for POS invoice / receipt footer
ALTER TABLE policies
  ADD COLUMN IF NOT EXISTS print_on_slip BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_policies_tenant_print_on_slip
  ON policies (tenant_id, print_on_slip)
  WHERE print_on_slip = true AND is_active = true;
