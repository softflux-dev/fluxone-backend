-- B2B Admin Settings (hardware devices) + Subscription invoices (SaaS billing)

CREATE TABLE IF NOT EXISTS hardware_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  device_name TEXT NOT NULL,
  hardware_signature TEXT NOT NULL,
  ip_address TEXT,
  mac_address TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'blocked')),
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, hardware_signature)
);

CREATE INDEX IF NOT EXISTS idx_hardware_devices_tenant
  ON hardware_devices (tenant_id);

CREATE INDEX IF NOT EXISTS idx_hardware_devices_tenant_status
  ON hardware_devices (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_hardware_devices_tenant_branch
  ON hardware_devices (tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL DEFAULT 'FluxOne Platform',
  branch_limit INT,
  auto_pay BOOLEAN NOT NULL DEFAULT false,
  next_renewal_at DATE,
  payment_method TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tracking_id TEXT NOT NULL,
  billed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid'
    CHECK (status IN ('paid', 'pending', 'failed', 'refunded')),
  billing_cycle TEXT,
  payment_method TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tracking_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant
  ON billing_invoices (tenant_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_tenant_billed_at
  ON billing_invoices (tenant_id, billed_at DESC);
