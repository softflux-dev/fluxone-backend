-- Branch Manager Resources: POS hardware assets + item weighing/packaging scales.

CREATE TABLE IF NOT EXISTS branch_hardware (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Computers', 'Scanners', 'Printers', 'Telephone', 'Other')),
  status TEXT NOT NULL CHECK (status IN ('New', 'Used', 'Good', 'Poor')),
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, code)
);

CREATE INDEX IF NOT EXISTS idx_branch_hardware_tenant_branch
  ON branch_hardware (tenant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_branch_hardware_tenant_type
  ON branch_hardware (tenant_id, branch_id, type);

CREATE TABLE IF NOT EXISTS item_scales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_item_scales_tenant
  ON item_scales (tenant_id);

-- Optional category on discount offers (for BM Discount Management filter).
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_offers_tenant_category
  ON offers (tenant_id, category_id);

-- Default item scales for every tenant (idempotent).
INSERT INTO item_scales (tenant_id, name)
SELECT t.id, s.name
FROM tenants t
CROSS JOIN (
  VALUES ('kg'), ('pound'), ('Piece'), ('Box')
) AS s(name)
ON CONFLICT (tenant_id, name) DO NOTHING;
