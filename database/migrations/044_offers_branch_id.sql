-- TC-discount-002 — Discount offers are branch-owned (not tenant-wide shared)

ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

-- Backfill from linked category (most BM offers are category-scoped)
UPDATE offers o
SET branch_id = c.branch_id
FROM categories c
WHERE o.tenant_id = c.tenant_id
  AND o.category_id = c.id
  AND o.branch_id IS NULL
  AND c.branch_id IS NOT NULL;

-- Backfill from products that already use the offer (single-branch usage only)
UPDATE offers o
SET branch_id = sub.branch_id
FROM (
  SELECT
    p.offer_id,
    (MIN(p.branch_id::text))::uuid AS branch_id
  FROM products p
  WHERE p.offer_id IS NOT NULL
    AND p.branch_id IS NOT NULL
  GROUP BY p.offer_id
  HAVING COUNT(DISTINCT p.branch_id) = 1
) sub
WHERE o.id = sub.offer_id
  AND o.branch_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_offers_tenant_branch
  ON offers (tenant_id, branch_id);
