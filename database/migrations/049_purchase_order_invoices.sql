-- TL §10 Phase 2 — Purchase order invoices (one per supplier company per order)
-- Generated on BM approve from approved quantities; locked thereafter (no regenerate).
-- Billing / SaaS invoices (billing_invoices) are unrelated.

-- ---------------------------------------------------------------------------
-- 1) Tenant-year counter → INV-YYYY-##### (e.g. INV-2026-00143)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_invoice_counters (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, year),
  CONSTRAINT purchase_order_invoice_counters_year_check CHECK (year >= 2000),
  CONSTRAINT purchase_order_invoice_counters_last_value_check CHECK (last_value >= 0)
);

-- ---------------------------------------------------------------------------
-- 2) Header — one invoice per (order, supplier company)
-- Snapshots freeze supplier/branch details at approve time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  invoice_date TIMESTAMPTZ NOT NULL,
  -- Supplier snapshot (TL §10.2)
  supplier_company_name TEXT NOT NULL,
  supplier_location TEXT,
  supplier_registration_number TEXT,
  supplier_representative_name TEXT,
  supplier_representative_email TEXT,
  supplier_signature_url TEXT,
  -- Branch snapshot (issuing branch)
  branch_name TEXT NOT NULL,
  branch_location TEXT,
  branch_contact TEXT,
  -- Email send tracking (TL §10.3 Send to Supplier)
  last_sent_at TIMESTAMPTZ,
  last_sent_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, purchase_order_id, supplier_id),
  UNIQUE (tenant_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_po_invoices_tenant_po
  ON purchase_order_invoices (tenant_id, purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_po_invoices_tenant_supplier
  ON purchase_order_invoices (tenant_id, supplier_id);

CREATE INDEX IF NOT EXISTS idx_po_invoices_tenant_branch
  ON purchase_order_invoices (tenant_id, branch_id);

-- ---------------------------------------------------------------------------
-- 3) Line snapshot — approved qty + previous unit price (locked)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES purchase_order_invoices(id) ON DELETE CASCADE,
  purchase_order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  variant_label TEXT,
  scale TEXT,
  quantity NUMERIC(14,3) NOT NULL,
  previous_unit_price NUMERIC(14,4) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,4) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_order_invoice_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT purchase_order_invoice_items_price_check CHECK (previous_unit_price >= 0),
  CONSTRAINT purchase_order_invoice_items_total_check CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_po_invoice_items_tenant_invoice
  ON purchase_order_invoice_items (tenant_id, invoice_id, sort_order ASC);
