import { tenantQuery } from '../../config/db.js'
import { ROLE_IDS, ROLES } from '../../config/constants.js'

export async function createNotification(
  tenantId,
  {
    recipientUserId,
    type,
    title,
    body = null,
    linkPath = null,
    entityType = null,
    entityId = null,
    meta = {},
  },
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO notifications (
        tenant_id, recipient_user_id, type, title, body,
        link_path, entity_type, entity_id, meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING
        id,
        recipient_user_id AS "recipientUserId",
        type,
        title,
        body,
        link_path AS "linkPath",
        entity_type AS "entityType",
        entity_id AS "entityId",
        meta,
        is_read AS "isRead",
        read_at AS "readAt",
        created_at AS "createdAt"
    `,
    [
      recipientUserId,
      type,
      title,
      body,
      linkPath,
      entityType,
      entityId,
      JSON.stringify(meta || {}),
    ],
  )
  return rows[0]
}

// Create the same notification for many recipients (e.g. all tenant admins)
export async function createNotificationsForUsers(tenantId, recipientUserIds, payload) {
  const created = []
  for (const recipientUserId of recipientUserIds) {
    const row = await createNotification(tenantId, { ...payload, recipientUserId })
    created.push(row)
  }
  return created
}

export async function listUserIdsByRole(tenantId, roleSlug) {
  const roleId = ROLE_IDS[roleSlug]
  if (!roleId) return []
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM users
      WHERE tenant_id = $1
        AND role_id = $2
        AND is_active = true
    `,
    [roleId],
  )
  return rows.map((r) => r.id)
}

export async function listTenantAdminUserIds(tenantId) {
  return listUserIdsByRole(tenantId, ROLES.B2B_ADMIN)
}

// Branch Managers for one branch only — never broadcast to other branches
export async function listBranchManagerIdsForBranch(tenantId, branchId) {
  if (!branchId) return []
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM users
      WHERE tenant_id = $1
        AND role_id = $2
        AND is_active = true
        AND branch_id = $3
    `,
    [ROLE_IDS[ROLES.BRANCH_MANAGER], branchId],
  )
  return rows.map((r) => r.id)
}

// Inventory Managers for one branch only — stock requests must not cross branches
export async function listInventoryManagerIdsForBranch(tenantId, branchId) {
  if (!branchId) return []
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM users
      WHERE tenant_id = $1
        AND role_id = $2
        AND is_active = true
        AND branch_id = $3
    `,
    [ROLE_IDS[ROLES.INVENTORY_MANAGER], branchId],
  )
  return rows.map((r) => r.id)
}

// Active users linked to a branch (users.branch_id or staff row); optional excludes
export async function listBranchUserIds(tenantId, branchId, { excludeUserIds = [] } = {}) {
  if (!branchId) return []
  const exclude = (Array.isArray(excludeUserIds) ? excludeUserIds : []).filter(Boolean)
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT DISTINCT u.id
      FROM users u
      WHERE u.tenant_id = $1
        AND u.is_active = true
        AND u.role_id <> $2
        AND (
          u.branch_id = $3
          OR EXISTS (
            SELECT 1
            FROM staff s
            WHERE s.tenant_id = u.tenant_id
              AND s.user_id = u.id
              AND s.branch_id = $3
              AND s.status = 'active'
          )
        )
        AND (
          cardinality($4::uuid[]) = 0
          OR NOT (u.id = ANY ($4::uuid[]))
        )
    `,
    [ROLE_IDS[ROLES.B2B_ADMIN], branchId, exclude],
  )
  return rows.map((r) => r.id)
}

export async function listNotifications(
  tenantId,
  { recipientUserId, unreadOnly = false, limit = 50, offset = 0 } = {},
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        type,
        title,
        body,
        link_path AS "linkPath",
        entity_type AS "entityType",
        entity_id AS "entityId",
        meta,
        is_read AS "isRead",
        read_at AS "readAt",
        created_at AS "createdAt"
      FROM notifications
      WHERE tenant_id = $1
        AND recipient_user_id = $2
        AND ($3::boolean IS FALSE OR is_read = false)
      ORDER BY created_at DESC
      LIMIT $4 OFFSET $5
    `,
    [recipientUserId, Boolean(unreadOnly), limit, offset],
  )
  return rows
}

export async function countUnreadNotifications(tenantId, recipientUserId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE tenant_id = $1
        AND recipient_user_id = $2
        AND is_read = false
    `,
    [recipientUserId],
  )
  return rows[0]?.count || 0
}

export async function getNotificationById(tenantId, id, recipientUserId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        type,
        title,
        body,
        link_path AS "linkPath",
        entity_type AS "entityType",
        entity_id AS "entityId",
        meta,
        is_read AS "isRead",
        read_at AS "readAt",
        created_at AS "createdAt"
      FROM notifications
      WHERE tenant_id = $1
        AND id = $2
        AND recipient_user_id = $3
      LIMIT 1
    `,
    [id, recipientUserId],
  )
  return rows[0] || null
}

export async function markNotificationRead(tenantId, id, recipientUserId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE notifications
      SET is_read = true, read_at = COALESCE(read_at, now())
      WHERE tenant_id = $1
        AND id = $2
        AND recipient_user_id = $3
      RETURNING id, is_read AS "isRead", read_at AS "readAt"
    `,
    [id, recipientUserId],
  )
  return rows[0] || null
}

export async function markAllNotificationsRead(tenantId, recipientUserId) {
  const { rowCount } = await tenantQuery(
    tenantId,
    `
      UPDATE notifications
      SET is_read = true, read_at = COALESCE(read_at, now())
      WHERE tenant_id = $1
        AND recipient_user_id = $2
        AND is_read = false
    `,
    [recipientUserId],
  )
  return rowCount || 0
}

export async function deleteNotification(tenantId, id, recipientUserId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      DELETE FROM notifications
      WHERE tenant_id = $1
        AND id = $2
        AND recipient_user_id = $3
      RETURNING id
    `,
    [id, recipientUserId],
  )
  return rows[0] || null
}
