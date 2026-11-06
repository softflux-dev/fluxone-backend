-- Phase 4: opaque auth_sessions is the only cloud auth mechanism.
-- Refresh-token rotation table is retired after cutover.

DROP TABLE IF EXISTS refresh_tokens;
