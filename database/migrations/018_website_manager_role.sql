-- Website Manager staff role (BM Staff create dropdown)
INSERT INTO roles (id, slug, name) VALUES
  (8, 'website_manager', 'Website Manager')
ON CONFLICT (id) DO NOTHING;
