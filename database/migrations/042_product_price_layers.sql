-- Sell-price layers: old stock keeps its price until it is sold (FIFO).
-- Toggle OFF (price_requires_stock_utilized = true) is the default.

CREATE TABLE IF NOT EXISTS product_price_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_remaining NUMERIC NOT NULL CHECK (quantity_remaining >= 0),
  selling_price NUMERIC NOT NULL DEFAULT 0,
  purchase_price NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_layers_product_fifo
  ON product_price_layers (tenant_id, product_id, created_at, id)
  WHERE quantity_remaining > 0;
