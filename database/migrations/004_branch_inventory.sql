-- Phase 2: per-branch stock balances for multi-warehouse transfers
CREATE TABLE IF NOT EXISTS branch_inventory (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_inventory_tenant ON branch_inventory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_branch_inventory_branch ON branch_inventory(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_inventory_product ON branch_inventory(product_id);
