-- Supplier uniqueness per branch (industry: reg # is company key; name prevents lookalike dupes).
-- App also enforces via assertUniqueSupplier. Indexes skipped if legacy duplicates still exist.

DO $$
DECLARE
  name_dupes int;
  reg_dupes int;
BEGIN
  SELECT count(*)::int INTO name_dupes
  FROM (
    SELECT 1
    FROM suppliers
    GROUP BY tenant_id, branch_id, lower(btrim(company_name))
    HAVING count(*) > 1
  ) d;

  SELECT count(*)::int INTO reg_dupes
  FROM (
    SELECT 1
    FROM suppliers
    WHERE registration_number IS NOT NULL
      AND btrim(registration_number) <> ''
    GROUP BY tenant_id, branch_id, lower(btrim(registration_number))
    HAVING count(*) > 1
  ) d;

  IF name_dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_tenant_branch_company_lower
      ON suppliers (tenant_id, branch_id, lower(btrim(company_name)));
  ELSE
    RAISE NOTICE
      '052: skipped company-name unique index — % duplicate group(s). Clean suppliers then re-apply.',
      name_dupes;
  END IF;

  IF reg_dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_tenant_branch_reg_lower
      ON suppliers (tenant_id, branch_id, lower(btrim(registration_number)))
      WHERE registration_number IS NOT NULL
        AND btrim(registration_number) <> '';
  ELSE
    RAISE NOTICE
      '052: skipped registration unique index — % duplicate group(s). Clean suppliers then re-apply.',
      reg_dupes;
  END IF;
END $$;
