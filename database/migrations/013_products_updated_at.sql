-- Product catalog change tracking for POS delta pull + price sync
-- Policy A: products are already branch-scoped; selling_price lives on the product row.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE products
SET updated_at = COALESCE(created_at, now())
WHERE updated_at IS NULL OR updated_at < created_at;

CREATE INDEX IF NOT EXISTS idx_products_tenant_branch_updated
  ON products (tenant_id, branch_id, updated_at);
