-- Active / Inactive soft-disable for master data + staff status rename

-- Suppliers
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant_active
  ON suppliers (tenant_id, is_active);

-- Categories
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_categories_tenant_active
  ON categories (tenant_id, is_active);

-- Designations
ALTER TABLE designations
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_designations_tenant_active
  ON designations (tenant_id, is_active);

-- Products: open/close → active/inactive
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;

UPDATE products SET status = 'active' WHERE status = 'open';
UPDATE products SET status = 'inactive' WHERE status = 'close';

ALTER TABLE products
  ADD CONSTRAINT products_status_check
  CHECK (status IN ('active', 'inactive'));

ALTER TABLE products
  ALTER COLUMN status SET DEFAULT 'active';

-- Staff: open/blocked → active/inactive
ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_status_check;

UPDATE staff SET status = 'active' WHERE status = 'open';
UPDATE staff SET status = 'inactive' WHERE status = 'blocked';

ALTER TABLE staff
  ADD CONSTRAINT staff_status_check
  CHECK (status IN ('active', 'inactive'));

ALTER TABLE staff
  ALTER COLUMN status SET DEFAULT 'active';
