-- B2B Admin Tax & Profit: store explicit profit % on products (backfill from margin)

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS profit_percent NUMERIC(6,2) NOT NULL DEFAULT 0;

-- Derive from purchase/selling when purchase > 0 and margin is non-zero
UPDATE products
SET profit_percent = ROUND(
  GREATEST(
    0,
    LEAST(
      999.99,
      ((selling_price - purchase_price) / NULLIF(purchase_price, 0)) * 100
    )
  )::numeric,
  2
)
WHERE purchase_price > 0
  AND selling_price IS DISTINCT FROM purchase_price
  AND COALESCE(profit_percent, 0) = 0;

CREATE INDEX IF NOT EXISTS idx_products_tenant_profit_percent
  ON products (tenant_id, profit_percent DESC);

CREATE INDEX IF NOT EXISTS idx_products_tenant_scale
  ON products (tenant_id, scale);
