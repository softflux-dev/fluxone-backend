-- Tag Control entries that originated from the Adjustment dialog so they can
-- appear on both Adjustment + Stock In / Stock Out history tabs.
ALTER TABLE inventory_ledger
  ADD COLUMN IF NOT EXISTS control_source TEXT;

CREATE INDEX IF NOT EXISTS idx_ledger_control_source
  ON inventory_ledger (tenant_id, control_source)
  WHERE control_source IS NOT NULL;
