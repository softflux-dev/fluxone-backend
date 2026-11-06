-- B2B Admin Company Details + Policies (tenant profile fields + policies handbook)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS contact_numbers TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT,
  ADD COLUMN IF NOT EXISTS facebook_url TEXT,
  ADD COLUMN IF NOT EXISTS instagram_url TEXT,
  ADD COLUMN IF NOT EXISTS registration_tax_id TEXT,
  ADD COLUMN IF NOT EXISTS business_address TEXT,
  ADD COLUMN IF NOT EXISTS support_email TEXT;

CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  detail TEXT NOT NULL,
  category TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)

CREATE INDEX IF NOT EXISTS idx_policies_tenant
  ON policies (tenant_id);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_category
  ON policies (tenant_id, category);

CREATE INDEX IF NOT EXISTS idx_policies_tenant_active
  ON policies (tenant_id, is_active);
