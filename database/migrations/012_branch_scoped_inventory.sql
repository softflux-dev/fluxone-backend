-- Branch-scoped inventory catalog (Option B)
-- Products, categories, suppliers, and purchase_orders become per-branch within a tenant.
-- taxes / offers remain tenant-wide (shared company rates/promos).
--
-- Backfill strategy:
--   Assign legacy catalog/PO rows to the oldest branch per tenant (ORDER BY created_at, id).
--   Demo impact: Wah + Haripur legacy data lands on Wah only — Haripur IM sees empty catalog
--   (no cross-branch leak). B2B Admin still sees all branches after backfill.
--   New IM rows always set branch_id from JWT (NOT NULL).

-- 1) columns
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE RESTRICT;

-- 2) backfill from oldest branch per tenant
WITH first_branch AS (
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    id AS branch_id
  FROM branches
  ORDER BY tenant_id, created_at ASC NULLS LAST, id ASC
)
UPDATE categories c
SET branch_id = fb.branch_id
FROM first_branch fb
WHERE c.tenant_id = fb.tenant_id
  AND c.branch_id IS NULL;

WITH first_branch AS (
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    id AS branch_id
  FROM branches
  ORDER BY tenant_id, created_at ASC NULLS LAST, id ASC
)
UPDATE products p
SET branch_id = fb.branch_id
FROM first_branch fb
WHERE p.tenant_id = fb.tenant_id
  AND p.branch_id IS NULL;

WITH first_branch AS (
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    id AS branch_id
  FROM branches
  ORDER BY tenant_id, created_at ASC NULLS LAST, id ASC
)
UPDATE suppliers s
SET branch_id = fb.branch_id
FROM first_branch fb
WHERE s.tenant_id = fb.tenant_id
  AND s.branch_id IS NULL;

WITH first_branch AS (
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    id AS branch_id
  FROM branches
  ORDER BY tenant_id, created_at ASC NULLS LAST, id ASC
)
UPDATE purchase_orders po
SET branch_id = fb.branch_id
FROM first_branch fb
WHERE po.tenant_id = fb.tenant_id
  AND po.branch_id IS NULL;

-- 3) require branch_id once backfilled (skip SET NOT NULL if orphans remain — e.g. tenant with no branches)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM categories WHERE branch_id IS NULL) THEN
    ALTER TABLE categories ALTER COLUMN branch_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM products WHERE branch_id IS NULL) THEN
    ALTER TABLE products ALTER COLUMN branch_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE branch_id IS NULL) THEN
    ALTER TABLE suppliers ALTER COLUMN branch_id SET NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE branch_id IS NULL) THEN
    ALTER TABLE purchase_orders ALTER COLUMN branch_id SET NOT NULL;
  END IF;
END $$;

-- 4) drop tenant-only uniques; add branch-scoped uniques
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_id_item_code_key;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tenant_id_barcode_key;

DROP INDEX IF EXISTS products_tenant_id_item_code_key;
DROP INDEX IF EXISTS products_tenant_id_barcode_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_branch_item_code
  ON products (tenant_id, branch_id, item_code);

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_branch_barcode
  ON products (tenant_id, branch_id, barcode);

ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_tenant_id_order_number_key;
DROP INDEX IF EXISTS purchase_orders_tenant_id_order_number_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_orders_tenant_branch_order_number
  ON purchase_orders (tenant_id, branch_id, order_number);

-- Category name uniqueness per branch + parent (NULLs treated via COALESCE for roots)
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_tenant_branch_parent_name
  ON categories (
    tenant_id,
    branch_id,
    (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    name
  );

-- 5) lookup indexes
CREATE INDEX IF NOT EXISTS idx_categories_tenant_branch ON categories (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant_branch ON products (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_branch ON suppliers (tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_branch ON purchase_orders (tenant_id, branch_id);
