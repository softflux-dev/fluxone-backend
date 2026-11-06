-- POS-aligned invoice sync: current-state pull + in-place return/exchange.
-- original_sale_number for audit/link; invoice_type for Sale/Return/Exchange;
-- is_returned on lines for partial returns.

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS original_sale_number TEXT,
  ADD COLUMN IF NOT EXISTS invoice_type TEXT NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sales_invoice_type_check'
  ) THEN
    ALTER TABLE sales
      ADD CONSTRAINT sales_invoice_type_check
      CHECK (invoice_type IN ('sale', 'return', 'exchange'));
  END IF;
END $$;

ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS is_returned BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch_sale_number
  ON sales (tenant_id, branch_id, sale_number);

CREATE INDEX IF NOT EXISTS idx_sales_original_sale_number
  ON sales (tenant_id, branch_id, original_sale_number)
  WHERE original_sale_number IS NOT NULL;
