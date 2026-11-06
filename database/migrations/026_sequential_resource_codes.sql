-- Sequential display codes for Resources (HW-001 / ITM-001).

ALTER TABLE item_scales
  ADD COLUMN IF NOT EXISTS code TEXT;

-- Backfill item scale codes per tenant (creation order).
WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id
      ORDER BY created_at ASC NULLS LAST, name ASC
    ) AS rn
  FROM item_scales
)
UPDATE item_scales s
SET code = 'ITM-' || LPAD(n.rn::text, 3, '0')
FROM numbered n
WHERE s.id = n.id
  AND (s.code IS NULL OR s.code = '' OR s.code !~ '^ITM-[0-9]+$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_item_scales_tenant_code
  ON item_scales (tenant_id, code)
  WHERE code IS NOT NULL;

-- Re-number existing hardware to sequential HW-001 per branch.
WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, branch_id
      ORDER BY created_at ASC NULLS LAST, name ASC
    ) AS rn
  FROM branch_hardware
)
UPDATE branch_hardware h
SET code = 'HW-' || LPAD(n.rn::text, 3, '0')
FROM numbered n
WHERE h.id = n.id;
