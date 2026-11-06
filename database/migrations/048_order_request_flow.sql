-- Order Request Flow (TL Phase 1 — schema only)
-- Supplier & Order Request: multi-company orders, BM review statuses,
-- multi-round receival, and append-only order timeline events.
--
-- Legacy behaviour:
--   Existing purchase_orders rows keep their current status (approved / received / cancelled).
--   No invented status rewrite. Header supplier_id remains for backward-compatible reads;
--   purchase_order_suppliers is the source of truth for company blocks going forward.

-- ---------------------------------------------------------------------------
-- 1) purchase_orders — TL statuses + review / receival metadata
-- ---------------------------------------------------------------------------
ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_status_check
  CHECK (
    status IN (
      'pending',
      'approved',
      'rejected',
      'partially_received',
      'received',
      'cancelled'
    )
  );

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_notes TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant_branch_status
  ON purchase_orders (tenant_id, branch_id, status);

-- ---------------------------------------------------------------------------
-- 2) purchase_order_suppliers — multi-company blocks (parent of line items)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, purchase_order_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_po_suppliers_tenant_po
  ON purchase_order_suppliers (tenant_id, purchase_order_id);

CREATE INDEX IF NOT EXISTS idx_po_suppliers_tenant_supplier
  ON purchase_order_suppliers (tenant_id, supplier_id);

-- Backfill one company block per legacy PO (single supplier_id header)
INSERT INTO purchase_order_suppliers (
  tenant_id,
  purchase_order_id,
  supplier_id,
  sort_order
)
SELECT
  po.tenant_id,
  po.id,
  po.supplier_id,
  0
FROM purchase_orders po
WHERE NOT EXISTS (
  SELECT 1
  FROM purchase_order_suppliers pos
  WHERE pos.tenant_id = po.tenant_id
    AND pos.purchase_order_id = po.id
    AND pos.supplier_id = po.supplier_id
);

-- ---------------------------------------------------------------------------
-- 3) purchase_order_items — per-company lines + received qty tracker
-- ---------------------------------------------------------------------------
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0;

-- Backfill line supplier from parent PO header (legacy single-company orders)
UPDATE purchase_order_items poi
SET supplier_id = po.supplier_id
FROM purchase_orders po
WHERE poi.purchase_order_id = po.id
  AND poi.tenant_id = po.tenant_id
  AND poi.supplier_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purchase_order_items WHERE supplier_id IS NULL
  ) THEN
    RAISE EXCEPTION 'purchase_order_items.supplier_id still null after backfill';
  END IF;
END $$;

ALTER TABLE purchase_order_items
  ALTER COLUMN supplier_id SET NOT NULL;

-- Same product may appear under different company blocks; replace old unique
ALTER TABLE purchase_order_items
  DROP CONSTRAINT IF EXISTS purchase_order_items_tenant_id_purchase_order_id_product_id_key;

DROP INDEX IF EXISTS idx_po_items_tenant_po_product;
DROP INDEX IF EXISTS purchase_order_items_tenant_id_purchase_order_id_product_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_items_tenant_po_supplier_product
  ON purchase_order_items (tenant_id, purchase_order_id, supplier_id, product_id);

CREATE INDEX IF NOT EXISTS idx_po_items_tenant_supplier
  ON purchase_order_items (tenant_id, supplier_id);

ALTER TABLE purchase_order_items
  DROP CONSTRAINT IF EXISTS purchase_order_items_received_quantity_check;

ALTER TABLE purchase_order_items
  ADD CONSTRAINT purchase_order_items_received_quantity_check
  CHECK (received_quantity >= 0);

-- ---------------------------------------------------------------------------
-- 4) Receival rounds (TL §6.1 — multiple batches until Mark Complete)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_receivals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_receivals_tenant_po
  ON purchase_order_receivals (tenant_id, purchase_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_receival_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receival_id UUID NOT NULL REFERENCES purchase_order_receivals(id) ON DELETE CASCADE,
  purchase_order_item_id UUID NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (tenant_id, receival_id, purchase_order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_po_receival_items_receival
  ON purchase_order_receival_items (tenant_id, receival_id);

CREATE INDEX IF NOT EXISTS idx_po_receival_items_po_item
  ON purchase_order_receival_items (tenant_id, purchase_order_item_id);

-- ---------------------------------------------------------------------------
-- 5) Order timeline / audit (TL §8 Order Timeline)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'created',
      'edited_by_bm',
      'approved',
      'rejected',
      'receival_recorded',
      'completed'
    )
  ),
  actor_id UUID REFERENCES users(id),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_events_tenant_po_created
  ON purchase_order_events (tenant_id, purchase_order_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_po_events_tenant_type
  ON purchase_order_events (tenant_id, event_type);
