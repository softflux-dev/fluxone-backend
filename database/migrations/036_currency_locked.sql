-- Lock tenant default currency after first Admin Settings save.
-- Developers can still change via Supabase: SET currency_locked = false, then update default_currency.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS currency_locked BOOLEAN NOT NULL DEFAULT false;

-- Already changed away from PKR, or already has a change event → treat as locked
UPDATE tenants t
SET currency_locked = true
WHERE t.currency_locked = false
  AND (
    COALESCE(t.default_currency, 'PKR') IS DISTINCT FROM 'PKR'
    OR EXISTS (
      SELECT 1 FROM currency_change_events e WHERE e.tenant_id = t.id
    )
  );
