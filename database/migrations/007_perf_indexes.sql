-- Batch 3: indexes for common inventory list / filter paths

CREATE INDEX IF NOT EXISTS idx_products_tenant_created
  ON products (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_tenant_category
  ON products (tenant_id, category_id);

CREATE INDEX IF NOT EXISTS idx_products_tenant_subcategory
  ON products (tenant_id, subcategory_id);

CREATE INDEX IF NOT EXISTS idx_products_tenant_type
  ON products (tenant_id, type);

CREATE INDEX IF NOT EXISTS idx_products_tenant_status
  ON products (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_product_taxes_tenant_product
  ON product_taxes (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_created
  ON purchase_orders (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_company
  ON suppliers (tenant_id, company_name);

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_tenant_type_created
  ON inventory_ledger (tenant_id, movement_type, created_at);
