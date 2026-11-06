-- Phase 2 staff roles (Production / Delivery) for BM staff create dropdown
INSERT INTO roles (id, slug, name) VALUES
  (6, 'production_staff', 'Production Staff'),
  (7, 'delivery_staff', 'Delivery Staff')
ON CONFLICT (id) DO NOTHING;
