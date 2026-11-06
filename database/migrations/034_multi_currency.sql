-- Multi-currency: stamp money rows + latest FX rates (PKR units per 1 foreign unit)

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'PKR';

ALTER TABLE billing_invoices
  ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'PKR';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_currency CHAR(3) NOT NULL DEFAULT 'PKR';

-- Backfill from tenant default where possible
UPDATE sales s
SET currency = COALESCE(t.default_currency, 'PKR')
FROM tenants t
WHERE t.id = s.tenant_id
  AND s.currency IS NOT DISTINCT FROM 'PKR'
  AND t.default_currency IS DISTINCT FROM 'PKR';

UPDATE products p
SET price_currency = COALESCE(t.default_currency, 'PKR')
FROM tenants t
WHERE t.id = p.tenant_id
  AND p.price_currency IS NOT DISTINCT FROM 'PKR'
  AND t.default_currency IS DISTINCT FROM 'PKR';

UPDATE billing_invoices b
SET currency = COALESCE(t.default_currency, 'PKR')
FROM tenants t
WHERE t.id = b.tenant_id
  AND b.currency IS NOT DISTINCT FROM 'PKR'
  AND t.default_currency IS DISTINCT FROM 'PKR';

CREATE TABLE IF NOT EXISTS exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency_code CHAR(3) NOT NULL,
  -- How many PKR equal 1 unit of currency_code (PKR itself is always 1)
  rate_to_pkr NUMERIC(18, 6) NOT NULL CHECK (rate_to_pkr > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, currency_code)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_tenant
  ON exchange_rates (tenant_id);

CREATE TABLE IF NOT EXISTS currency_change_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_currency CHAR(3) NOT NULL,
  to_currency CHAR(3) NOT NULL,
  rate_to_pkr NUMERIC(18, 6),
  products_converted INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_currency_change_events_tenant
  ON currency_change_events (tenant_id, created_at DESC);
