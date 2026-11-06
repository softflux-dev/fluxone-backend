-- Branch Manager dashboard: durable POS sales domain
-- Chosen over aggregating pos_sync_events because sync sale/refund payloads
-- currently only carry inventory lines (productId + quantity), not amounts,
-- counters, tax/discount, or sale numbers required by the dashboard.

CREATE TABLE IF NOT EXISTS pos_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, branch_id, code)
);

CREATE INDEX IF NOT EXISTS idx_pos_counters_tenant_branch ON pos_counters(tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  counter_id UUID REFERENCES pos_counters(id) ON DELETE SET NULL,
  sale_number TEXT,
  sold_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  final_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  return_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'refunded', 'partial_refund', 'void')),
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  pos_event_id UUID REFERENCES pos_sync_events(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_tenant_sold_at ON sales(tenant_id, sold_at);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch ON sales(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_counter ON sales(counter_id);
CREATE INDEX IF NOT EXISTS idx_sales_pos_event ON sales(tenant_id, pos_event_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  quantity NUMERIC(14,3) NOT NULL,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_exchange BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_items_tenant_sale ON sale_items(tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(tenant_id, product_id);
