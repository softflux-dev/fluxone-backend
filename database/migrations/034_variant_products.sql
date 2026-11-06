-- Variant products: parent (type=variant) + child SKUs (type=single, parent_id set).
-- Children are independent inventory rows; parent has no sellable stock.

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check;

ALTER TABLE products
  ADD CONSTRAINT products_type_check
  CHECK (type IN ('single', 'bundle', 'variant'));

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES products(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS creation_batch_id UUID,
  ADD COLUMN IF NOT EXISTS variant_label TEXT,
  ADD COLUMN IF NOT EXISTS daily_price_change BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_products_tenant_parent
  ON products (tenant_id, parent_id)
  WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_tenant_creation_batch
  ON products (tenant_id, creation_batch_id)
  WHERE creation_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_tenant_branch_parent
  ON products (tenant_id, branch_id, parent_id);

-- Combination parts (catalog FKs optional — custom type/value stays product-local until BM promotes)
CREATE TABLE IF NOT EXISTS product_variant_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  variant_type_id UUID REFERENCES variant_types(id) ON DELETE SET NULL,
  variant_value_id UUID REFERENCES variant_values(id) ON DELETE SET NULL,
  type_name TEXT NOT NULL,
  value_name TEXT NOT NULL,
  is_custom_type BOOLEAN NOT NULL DEFAULT false,
  is_custom_value BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT product_variant_options_names_not_blank CHECK (
    length(trim(type_name)) > 0 AND length(trim(value_name)) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variant_options_product_sort
  ON product_variant_options (tenant_id, product_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_product_variant_options_product
  ON product_variant_options (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS idx_product_variant_options_type
  ON product_variant_options (tenant_id, variant_type_id)
  WHERE variant_type_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_variant_options_value
  ON product_variant_options (tenant_id, variant_value_id)
  WHERE variant_value_id IS NOT NULL;
