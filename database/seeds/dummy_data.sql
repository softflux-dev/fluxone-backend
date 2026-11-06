-- Dummy B2B admins + Branch Managers only (no Inventory Managers).
-- Inventory Managers / Cashiers are created by Branch Manager via Staff Management.
-- {{PASSWORD_HASH}} is replaced by database/seeds/seed.js
-- Demo password (seeded users only): password

INSERT INTO tenants (id, name, slug) VALUES
  ('33333333-3333-3333-3333-333333333333', 'SoftwareFlux', 'softwareflux')
ON CONFLICT (slug) DO NOTHING;


-- B2B Admins + Branch Managers only (upsert by primary key)
INSERT INTO users (id, tenant_id, branch_id, role_id, full_name, email, password_hash) VALUES
  -- SoftwareFlux: B2B Admin (upward product flow — password: admin123)
  ('c1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', NULL, 3, 'SoftwareFlux Admin', 'softwareflux@company.com', '{{ADMIN123_HASH}}')
ON CONFLICT (id) DO UPDATE
SET
  tenant_id = EXCLUDED.tenant_id,
  branch_id = EXCLUDED.branch_id,
  role_id = EXCLUDED.role_id,
  full_name = EXCLUDED.full_name,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  is_active = true;



-- Staff designations (B2B Admin master data). BM assigns staff roles from dropdown.
INSERT INTO designations (tenant_id, name) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Inventory Manager'),
  ('33333333-3333-3333-3333-333333333333', 'Cashier'),
  ('33333333-3333-3333-3333-333333333333', 'Production Staff'),
  ('33333333-3333-3333-3333-333333333333', 'Delivery Staff'),
  ('33333333-3333-3333-3333-333333333333', 'Website Manager'),
  ('33333333-3333-3333-3333-333333333333', 'Branch Manager')
ON CONFLICT (tenant_id, name) DO NOTHING;
