import { query } from '../../config/db.js'

// Create a new opaque session row (token secret is never inserted — only hash).
export async function createSession({
  id,
  userId,
  tenantId,
  tokenHash,
  expiresAt,
  absoluteExpiresAt,
  userAgent = null,
  ipAddress = null,
  deviceLabel = null,
}) {
  const { rows } = await query(
    `
      INSERT INTO auth_sessions (
        id,
        user_id,
        tenant_id,
        token_hash,
        expires_at,
        absolute_expires_at,
        user_agent,
        ip_address,
        device_label
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id,
        user_id AS "userId",
        tenant_id AS "tenantId",
        expires_at AS "expiresAt",
        absolute_expires_at AS "absoluteExpiresAt",
        revoked_at AS "revokedAt",
        last_seen_at AS "lastSeenAt",
        created_at AS "createdAt"
    `,
    [
      id,
      userId,
      tenantId,
      tokenHash,
      expiresAt,
      absoluteExpiresAt,
      userAgent,
      ipAddress,
      deviceLabel,
    ],
  )
  return rows[0]
}

// Lookup by token hash + join live user/role/branch for middleware.
export async function findActiveByTokenHash(tokenHash) {
  const { rows } = await query(
    `
      SELECT
        s.id,
        s.user_id AS "userId",
        s.tenant_id AS "tenantId",
        s.token_hash AS "tokenHash",
        s.expires_at AS "expiresAt",
        s.absolute_expires_at AS "absoluteExpiresAt",
        s.revoked_at AS "revokedAt",
        s.last_seen_at AS "lastSeenAt",
        s.created_at AS "createdAt",
        u.is_active AS "isActive",
        u.branch_id AS "branchId",
        r.slug AS role,
        b.status AS "branchStatus"
      FROM auth_sessions s
      JOIN users u
        ON u.id = s.user_id
       AND u.tenant_id = s.tenant_id
      JOIN roles r
        ON r.id = u.role_id
      LEFT JOIN branches b
        ON b.id = u.branch_id
       AND b.tenant_id = u.tenant_id
      WHERE s.token_hash = $1
      LIMIT 1
    `,
    [tokenHash],
  )
  return rows[0] || null
}

// Sliding expiry / last_seen bump.
export async function touchSession(id, { expiresAt = null, lastSeenAt = new Date() } = {}) {
  const { rows } = await query(
    `
      UPDATE auth_sessions
      SET
        last_seen_at = $2,
        expires_at = COALESCE($3, expires_at)
      WHERE id = $1
        AND revoked_at IS NULL
      RETURNING
        id,
        expires_at AS "expiresAt",
        absolute_expires_at AS "absoluteExpiresAt",
        last_seen_at AS "lastSeenAt"
    `,
    [id, lastSeenAt, expiresAt],
  )
  return rows[0] || null
}

export async function revokeById(id) {
  const { rowCount } = await query(
    `
      UPDATE auth_sessions
      SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE id = $1
        AND revoked_at IS NULL
    `,
    [id],
  )
  return rowCount > 0
}

export async function revokeByTokenHash(tokenHash) {
  const { rowCount } = await query(
    `
      UPDATE auth_sessions
      SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE token_hash = $1
        AND revoked_at IS NULL
    `,
    [tokenHash],
  )
  return rowCount > 0
}

export async function revokeAllForUser(userId, tenantId) {
  const { rowCount } = await query(
    `
      UPDATE auth_sessions
      SET revoked_at = NOW()
      WHERE user_id = $1
        AND tenant_id = $2
        AND revoked_at IS NULL
    `,
    [userId, tenantId],
  )
  return rowCount
}

// Kill sessions for every user tied to a branch (branch block).
export async function revokeForBranch(tenantId, branchId) {
  const { rowCount } = await query(
    `
      UPDATE auth_sessions s
      SET revoked_at = NOW()
      FROM users u
      WHERE s.user_id = u.id
        AND s.tenant_id = $1
        AND u.tenant_id = $1
        AND u.branch_id = $2
        AND s.revoked_at IS NULL
    `,
    [tenantId, branchId],
  )
  return rowCount
}

// Phase 2/6 session list UI.
export async function listActiveForUser(userId, tenantId) {
  const { rows } = await query(
    `
      SELECT
        id,
        user_agent AS "userAgent",
        ip_address AS "ipAddress",
        device_label AS "deviceLabel",
        expires_at AS "expiresAt",
        absolute_expires_at AS "absoluteExpiresAt",
        last_seen_at AS "lastSeenAt",
        created_at AS "createdAt"
      FROM auth_sessions
      WHERE user_id = $1
        AND tenant_id = $2
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND absolute_expires_at > NOW()
      ORDER BY last_seen_at DESC
    `,
    [userId, tenantId],
  )
  return rows
}