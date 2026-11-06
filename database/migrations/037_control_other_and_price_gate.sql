-- Phase 5: Others ledger type + utilization-gated price setting

-- Expand movement_type CHECK to allow 'other'
ALTER TABLE inventory_ledger
  DROP CONSTRAINT IF EXISTS inventory_ledger_movement_type_check;

ALTER TABLE inventory_ledger
  ADD CONSTRAINT inventory_ledger_movement_type_check
  CHECK (
    movement_type IN (
      'in',
      'out',
      'adjustment',
      'damaged',
      'expired',
      'transfer',
      'other'
    )
  );

-- When true: purchase/selling price may change only if on-hand stock is fully utilized (qty = 0).
-- Toggle via PATCH /inventory/control/price-rule { priceRequiresStockUtilized }.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS price_requires_stock_utilized BOOLEAN NOT NULL DEFAULT true;
