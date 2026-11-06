-- Admin Logs Phase 0 — category column for tab/filter scoping.
-- Categories align with docs/Admin Logs Module.md §2.1 tabs (excl. All Activity).

ALTER TABLE activity_logs
  ADD COLUMN IF NOT EXISTS category TEXT;

-- Backfill legacy POS / early rows from known action slugs
UPDATE activity_logs
SET category = CASE action
  WHEN 'stock_in' THEN 'stock'
  WHEN 'stock_out' THEN 'stock'
  WHEN 'stock_adjustment' THEN 'stock'
  WHEN 'sale' THEN 'stock'
  WHEN 'refund' THEN 'stock'
  WHEN 'price_change' THEN 'pricing'
  WHEN 'staff_create' THEN 'employees'
  WHEN 'staff_update' THEN 'employees'
  WHEN 'staff_delete' THEN 'employees'
  WHEN 'order_generate' THEN 'orders_suppliers'
  WHEN 'order_approve' THEN 'orders_suppliers'
  -- POS session / drawer events → settings (no dedicated POS tab)
  WHEN 'login' THEN 'settings'
  WHEN 'logout' THEN 'settings'
  WHEN 'open_cash_drawer' THEN 'settings'
  WHEN 'close_cash_drawer' THEN 'settings'
  WHEN 'change_cashier' THEN 'employees'
  ELSE 'settings'
END
WHERE category IS NULL;

ALTER TABLE activity_logs
  ALTER COLUMN category SET DEFAULT 'settings';

ALTER TABLE activity_logs
  ALTER COLUMN category SET NOT NULL;

ALTER TABLE activity_logs
  DROP CONSTRAINT IF EXISTS activity_logs_category_check;

ALTER TABLE activity_logs
  ADD CONSTRAINT activity_logs_category_check
  CHECK (
    category IN (
      'stock',
      'pricing',
      'products',
      'bundles',
      'variants',
      'employees',
      'settings',
      'hardware',
      'orders_suppliers'
    )
  );

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_category_created
  ON activity_logs (tenant_id, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_branch_category_created
  ON activity_logs (tenant_id, branch_id, category, created_at DESC);
