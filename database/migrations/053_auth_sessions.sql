CREATE TABLE IF NOT EXISTS auth_sessions (
  id                    UUID PRIMARY KEY,
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL UNIQUE,
  expires_at            TIMESTAMPTZ NOT NULL,
  absolute_expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ NULL,
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent            TEXT NULL,
  ip_address            TEXT NULL,
  device_label          TEXT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions (tenant_id, user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
  ON auth_sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash
  ON auth_sessions (token_hash)
  WHERE revoked_at IS NULL;