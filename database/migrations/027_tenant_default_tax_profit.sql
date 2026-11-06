-- Migration: 027_tenant_default_tax_profit.sql
-- Store tenant-level default profit % and default tax %

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_profit_percent NUMERIC(6,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_tax_percent NUMERIC(6,2) NOT NULL DEFAULT 0;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS profit_percent NUMERIC(6,2) NOT NULL DEFAULT 0;
