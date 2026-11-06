-- Branch-scoped activity feed (POS / BM / IM / system). Foundation for Activity Logs.

CREATE TABLE IF NOT EXISTS activity_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('pos', 'bm', 'im', 'system')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  pos_event_id UUID REFERENCES pos_sync_events(id) ON DELETE SET NULL,
  client_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_branch_created
  ON activity_logs (tenant_id, branch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_branch_action
  ON activity_logs (tenant_id, branch_id, action);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_actor
  ON activity_logs (tenant_id, actor_user_id);

-- Idempotent POS inserts (Order 2+): unique when client_event_id is present
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_logs_tenant_client_event
  ON activity_logs (tenant_id, client_event_id)
  WHERE client_event_id IS NOT NULL;
