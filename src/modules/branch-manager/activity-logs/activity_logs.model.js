import { tenantQuery } from '../../../config/db.js'
import { formatActivityMessage } from '../../../utils/activityLog.util.js'

function mapRow(row) {
  return {
    id: row.id,
    actorName: row.actorName,
    actorRole: row.actorRole,
    actorUserId: row.actorUserId,
    action: row.action,
    source: row.source,
    entityType: row.entityType,
    entityId: row.entityId,
    details: row.details || {},
    createdAt: row.createdAt,
    message: formatActivityMessage(row.actorName, row.action, row.details || {}),
  }
}

/**
 * Paginated branch activity feed.
 * Filters: branchId, from, to, action, source, q (actor_name / action).
 */
export async function listActivityLogs(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit

  const params = [
    filters.branchId || null,
    filters.from || null,
    filters.to || null,
    filters.action || null,
    filters.source || null,
    filters.q || null,
  ]

  const whereSql = `
    WHERE al.tenant_id = $1
      AND ($2::uuid IS NULL OR al.branch_id = $2)
      AND ($3::timestamptz IS NULL OR al.created_at >= $3)
      AND ($4::timestamptz IS NULL OR al.created_at <= $4)
      AND ($5::text IS NULL OR al.action = $5)
      AND ($6::text IS NULL OR al.source = $6)
      AND (
        $7::text IS NULL
        OR al.actor_name ILIKE '%' || $7 || '%'
        OR al.action ILIKE '%' || $7 || '%'
      )
  `

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM activity_logs al
      ${whereSql}
    `,
    params,
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        al.id,
        al.actor_name AS "actorName",
        al.actor_role AS "actorRole",
        al.actor_user_id AS "actorUserId",
        al.action,
        al.source,
        al.entity_type AS "entityType",
        al.entity_id AS "entityId",
        al.details,
        al.created_at AS "createdAt"
      FROM activity_logs al
      ${whereSql}
      ORDER BY al.created_at DESC
      LIMIT $8 OFFSET $9
    `,
    [...params, limit, offset],
  )

  return {
    items: rows.map(mapRow),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}
