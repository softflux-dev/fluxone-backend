-- Event-sourced stock movements and POS sync bridge (always scoped by tenant_id)
CREATE TABLE IF NOT EXISTS inventory_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  movement_type TEXT NOT NULL CHECK (
    movement_type IN ('in', 'out', 'adjustment', 'damaged', 'expired', 'transfer')
  ),
  quantity NUMERIC(14,3) NOT NULL,
  scale TEXT,
  reason TEXT,
  damaged_by_user_id UUID REFERENCES users(id),
  damaged_location TEXT,
  supplier_id UUID REFERENCES suppliers(id),
  from_branch_id UUID REFERENCES branches(id),
  to_branch_id UUID REFERENCES branches(id),
  pos_event_id UUID,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON inventory_ledger(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_product ON inventory_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_ledger_type ON inventory_ledger(movement_type);

CREATE TABLE IF NOT EXISTS pos_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id),
  device_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_event_id TEXT NOT NULL,
  synced_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_sync_tenant ON pos_sync_events(tenant_id);
