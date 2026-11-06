-- Tenant-level default currency (display / system default — not FX conversion)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_currency CHAR(3) NOT NULL DEFAULT 'PKR';
