-- Track whether a stock-in lot with expires_at has been converted to an expired movement
ALTER TABLE inventory_ledger
  ADD COLUMN IF NOT EXISTS expiry_processed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_ledger_expiry_due
  ON inventory_ledger (tenant_id, expires_at)
  WHERE movement_type = 'in' AND expires_at IS NOT NULL AND expiry_processed = FALSE;
