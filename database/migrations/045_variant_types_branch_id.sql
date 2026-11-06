-- Branch-scope variant catalog (types + values).
-- Multi-branch shared types (e.g. Type, Pack Size) are duplicated per branch
-- and product_variant_options FKs are remapped so each branch owns its catalog.

ALTER TABLE variant_types
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE variant_values
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

-- Usage: which product branches reference each type
CREATE TEMP TABLE _vt_branch_usage ON COMMIT DROP AS
SELECT DISTINCT
  vt.tenant_id,
  vt.id AS old_type_id,
  vt.name AS type_name,
  vt.is_active,
  p.branch_id
FROM variant_types vt
JOIN product_variant_options pvo
  ON pvo.variant_type_id = vt.id
 AND pvo.tenant_id = vt.tenant_id
JOIN products p
  ON p.id = pvo.product_id
 AND p.tenant_id = vt.tenant_id
WHERE p.branch_id IS NOT NULL;

-- Keeper = existing branch_id when it matches a usage branch; else oldest usage branch
CREATE TEMP TABLE _vt_keeper ON COMMIT DROP AS
SELECT DISTINCT ON (u.old_type_id)
  u.old_type_id,
  u.tenant_id,
  u.branch_id AS keeper_branch_id
FROM _vt_branch_usage u
JOIN variant_types vt ON vt.id = u.old_type_id
JOIN branches b ON b.id = u.branch_id
ORDER BY
  u.old_type_id,
  CASE WHEN vt.branch_id IS NOT NULL AND vt.branch_id = u.branch_id THEN 0 ELSE 1 END,
  b.created_at ASC NULLS LAST,
  b.id ASC;

-- Used types still null → keeper branch
UPDATE variant_types vt
SET branch_id = k.keeper_branch_id
FROM _vt_keeper k
WHERE vt.id = k.old_type_id
  AND vt.branch_id IS NULL;

-- Unused / leftover types → oldest branch in tenant
UPDATE variant_types vt
SET branch_id = fb.branch_id
FROM (
  SELECT DISTINCT ON (tenant_id)
    tenant_id,
    id AS branch_id
  FROM branches
  ORDER BY tenant_id, created_at ASC NULLS LAST, id ASC
) fb
WHERE vt.tenant_id = fb.tenant_id
  AND vt.branch_id IS NULL;

-- Drop tenant-wide uniques before same name can exist on different branches
DROP INDEX IF EXISTS uq_variant_types_tenant_name_lower;
DROP INDEX IF EXISTS uq_variant_values_tenant_type_name_lower;

CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_types_tenant_branch_name_lower
  ON variant_types (tenant_id, branch_id, lower(trim(name)));

CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_values_tenant_branch_type_name_lower
  ON variant_values (tenant_id, branch_id, variant_type_id, lower(trim(name)));

-- Rows that need a per-branch copy of the shared type
CREATE TEMP TABLE _vt_to_dup ON COMMIT DROP AS
SELECT
  u.tenant_id,
  u.old_type_id,
  u.type_name,
  u.is_active,
  u.branch_id
FROM _vt_branch_usage u
JOIN _vt_keeper k ON k.old_type_id = u.old_type_id
WHERE u.branch_id <> k.keeper_branch_id;

-- Insert missing branch copies (idempotent if already created)
INSERT INTO variant_types (tenant_id, branch_id, name, is_active)
SELECT d.tenant_id, d.branch_id, d.type_name, d.is_active
FROM _vt_to_dup d
WHERE NOT EXISTS (
  SELECT 1
  FROM variant_types vt
  WHERE vt.tenant_id = d.tenant_id
    AND vt.branch_id = d.branch_id
    AND lower(trim(vt.name)) = lower(trim(d.type_name))
);

-- Map old type → new type on each non-keeper branch
CREATE TEMP TABLE _vt_duplicates ON COMMIT DROP AS
SELECT
  d.old_type_id,
  vt.id AS new_type_id,
  d.branch_id,
  d.tenant_id
FROM _vt_to_dup d
JOIN variant_types vt
  ON vt.tenant_id = d.tenant_id
 AND vt.branch_id = d.branch_id
 AND lower(trim(vt.name)) = lower(trim(d.type_name))
WHERE vt.id <> d.old_type_id;

-- Copy missing values onto duplicated types
INSERT INTO variant_values (
  tenant_id, branch_id, variant_type_id, name, is_active, created_at, updated_at
)
SELECT
  vv.tenant_id,
  d.branch_id,
  d.new_type_id,
  vv.name,
  vv.is_active,
  vv.created_at,
  now()
FROM variant_values vv
JOIN _vt_duplicates d
  ON d.old_type_id = vv.variant_type_id
 AND d.tenant_id = vv.tenant_id
WHERE NOT EXISTS (
  SELECT 1
  FROM variant_values x
  WHERE x.tenant_id = vv.tenant_id
    AND x.branch_id = d.branch_id
    AND x.variant_type_id = d.new_type_id
    AND lower(trim(x.name)) = lower(trim(vv.name))
);

CREATE TEMP TABLE _vv_duplicates ON COMMIT DROP AS
SELECT
  vv.id AS old_value_id,
  nv.id AS new_value_id,
  d.old_type_id,
  d.new_type_id,
  d.branch_id
FROM variant_values vv
JOIN _vt_duplicates d
  ON d.old_type_id = vv.variant_type_id
 AND d.tenant_id = vv.tenant_id
JOIN variant_values nv
  ON nv.tenant_id = vv.tenant_id
 AND nv.branch_id = d.branch_id
 AND nv.variant_type_id = d.new_type_id
 AND lower(trim(nv.name)) = lower(trim(vv.name));

-- Remap product options on non-keeper branches to the duplicated catalog rows
-- (pvo may only appear in SET/WHERE — not in FROM JOIN ON)
UPDATE product_variant_options pvo
SET
  variant_type_id = d.new_type_id,
  variant_value_id = COALESCE(
    (
      SELECT m.new_value_id
      FROM _vv_duplicates m
      WHERE m.old_value_id = pvo.variant_value_id
        AND m.new_type_id = d.new_type_id
      LIMIT 1
    ),
    pvo.variant_value_id
  )
FROM products p
JOIN _vt_duplicates d
  ON d.tenant_id = p.tenant_id
 AND d.branch_id = p.branch_id
WHERE pvo.product_id = p.id
  AND pvo.tenant_id = p.tenant_id
  AND pvo.variant_type_id = d.old_type_id;

-- Values inherit their type's branch
UPDATE variant_values vv
SET branch_id = vt.branch_id
FROM variant_types vt
WHERE vv.variant_type_id = vt.id
  AND vv.tenant_id = vt.tenant_id
  AND (vv.branch_id IS NULL OR vv.branch_id IS DISTINCT FROM vt.branch_id);

-- Harden
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM variant_types WHERE branch_id IS NULL) THEN
    RAISE EXCEPTION 'variant_types.branch_id still null after backfill';
  END IF;
  IF EXISTS (SELECT 1 FROM variant_values WHERE branch_id IS NULL) THEN
    RAISE EXCEPTION 'variant_values.branch_id still null after backfill';
  END IF;
END $$;

ALTER TABLE variant_types
  ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE variant_values
  ALTER COLUMN branch_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_variant_types_tenant_branch
  ON variant_types (tenant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_variant_values_tenant_branch
  ON variant_values (tenant_id, branch_id);
