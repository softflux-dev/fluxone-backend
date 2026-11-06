-- Extra default item scales used by Inventory product forms (idempotent).
INSERT INTO item_scales (tenant_id, name)
SELECT t.id, s.name
FROM tenants t
CROSS JOIN (
  VALUES
    ('unit'),
    ('kg'),
    ('g'),
    ('liter'),
    ('ml'),
    ('pack'),
    ('box'),
    ('dozen'),
    ('pound'),
    ('Piece'),
    ('Box')
) AS s(name)
ON CONFLICT (tenant_id, name) DO NOTHING;
