-- POS (Local Admin) price changes awaiting IM approval. Price is live immediately; IM approves/rejects later.
CREATE TABLE IF NOT EXISTS pos_price_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_price NUMERIC(14,2) NOT NULL,
  new_price NUMERIC(14,2) NOT NULL,
  changed_by_user_id UUID,
  changed_by_name TEXT,
  device_id TEXT,
  client_event_id TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_price_changes_branch_status
  ON pos_price_changes (tenant_id, branch_id, status, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_price_changes_product
  ON pos_price_changes (tenant_id, branch_id, product_id, changed_at);
