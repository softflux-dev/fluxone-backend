-- Branch Manager Variant Management: Variant Types + Variant Values.
-- Parallel to item_scales (kept intact; Phase 2 migration skipped).

CREATE TABLE IF NOT EXISTS variant_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT variant_types_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_types_tenant_name_lower
  ON variant_types (tenant_id, lower(trim(name)));

CREATE INDEX IF NOT EXISTS idx_variant_types_tenant
  ON variant_types (tenant_id);

CREATE INDEX IF NOT EXISTS idx_variant_types_tenant_active
  ON variant_types (tenant_id, is_active);

CREATE TABLE IF NOT EXISTS variant_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_type_id UUID NOT NULL REFERENCES variant_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT variant_values_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_values_tenant_type_name_lower
  ON variant_values (tenant_id, variant_type_id, lower(trim(name)));

CREATE INDEX IF NOT EXISTS idx_variant_values_tenant
  ON variant_values (tenant_id);

CREATE INDEX IF NOT EXISTS idx_variant_values_tenant_type
  ON variant_values (tenant_id, variant_type_id);

CREATE INDEX IF NOT EXISTS idx_variant_values_tenant_active
  ON variant_values (tenant_id, is_active);
