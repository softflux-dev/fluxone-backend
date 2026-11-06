-- Track last daily price confirmation per product (Control banner clears when all updated today).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS daily_price_updated_on DATE;

CREATE INDEX IF NOT EXISTS idx_products_tenant_daily_price_pending
  ON products (tenant_id, daily_price_change, daily_price_updated_on)
  WHERE daily_price_change = true;
