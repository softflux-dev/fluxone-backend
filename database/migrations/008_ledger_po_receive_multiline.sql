-- Allow multi-line stock-in from a single purchase order.
-- Idempotency is enforced by PO status (approved → received), not a unique ledger index.
DROP INDEX IF EXISTS idx_ledger_single_po_receive;
