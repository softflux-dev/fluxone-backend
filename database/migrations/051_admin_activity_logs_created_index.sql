-- Admin Logs Phase 5 — All Activity / unbounded-branch date scans.
-- Complements 050 category indexes when category filter is absent.

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created
  ON activity_logs (tenant_id, created_at DESC);
