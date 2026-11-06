-- Phase 1: supplier fields, product vendor/price snapshots, purchase orders, stock requests, ledger extras

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS representative_phone TEXT,
  ADD COLUMN IF NOT EXISTS representative_email TEXT,
  ADD COLUMN IF NOT EXISTS location TEXT,
  ADD COLUMN IF NOT EXISTS tax_paid BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS registration_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS signature_url TEXT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_purchase_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS last_purchase_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_purchase_supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_selling_price NUMERIC(12,2);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  order_number TEXT NOT NULL,
  explanation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'received', 'cancelled')),
  created_by UUID REFERENCES users(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant ON purchase_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  scale TEXT NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_purchase_price NUMERIC(12,2),
  UNIQUE (tenant_id, purchase_order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_po_items_tenant ON purchase_order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_po_items_order ON purchase_order_items(purchase_order_id);

CREATE TABLE IF NOT EXISTS stock_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  remaining_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('alert', 'request')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_requests_tenant ON stock_requests(tenant_id);

ALTER TABLE inventory_ledger
  ADD COLUMN IF NOT EXISTS purchase_order_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expires_at DATE,
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_single_po_receive
  ON inventory_ledger (tenant_id, purchase_order_id)
  WHERE purchase_order_id IS NOT NULL AND movement_type = 'in';

ALTER TABLE product_taxes
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE product_taxes pt
SET tenant_id = p.tenant_id
FROM products p
WHERE pt.product_id = p.id AND pt.tenant_id IS NULL;

ALTER TABLE product_taxes
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE bundle_items
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

UPDATE bundle_items bi
SET tenant_id = p.tenant_id
FROM products p
WHERE bi.bundle_id = p.id AND bi.tenant_id IS NULL;

ALTER TABLE bundle_items
  ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE product_taxes DROP CONSTRAINT IF EXISTS product_taxes_pkey;
ALTER TABLE product_taxes ADD PRIMARY KEY (tenant_id, product_id, tax_id);

ALTER TABLE bundle_items DROP CONSTRAINT IF EXISTS bundle_items_pkey;
ALTER TABLE bundle_items ADD PRIMARY KEY (tenant_id, bundle_id, item_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_po_items_tenant_po_product
  ON purchase_order_items (tenant_id, purchase_order_id, product_id);
