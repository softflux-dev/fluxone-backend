import { ROLES, MOVEMENT_TYPES } from '../config/constants.js'
import { tenantClientQuery, tenantQuery } from '../config/db.js'
import { logActivity } from './activityLog.util.js'

export function activitySourceFromRole(role) {
  if (role === ROLES.INVENTORY_MANAGER) return 'im'
  if (role === ROLES.BRANCH_MANAGER || role === ROLES.BRANCH_ADMIN) return 'bm'
  if (role === ROLES.CASHIER) return 'pos'
  if (role === ROLES.B2B_ADMIN) return 'bm'
  return 'system'
}

export async function lookupActorName(tenantId, userId, client = null) {
  if (!userId) return 'System'
  const run = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)
  const { rows } = await run(
    `
      SELECT full_name AS "fullName"
      FROM users
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [userId],
  )
  const name = String(rows[0]?.fullName || '').trim()
  return name || 'Unknown user'
}

export async function lookupActorRole(tenantId, userId, client = null) {
  if (!userId) return 'system'
  const run = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)
  // users.role_id → roles.slug (no users.role column)
  const { rows } = await run(
    `
      SELECT r.slug AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1 AND u.id = $2
      LIMIT 1
    `,
    [userId],
  )
  return rows[0]?.role || 'unknown'
}

/** Tenant-wide settings need a branch_id — prefer actor branch, else first active branch. */
export async function resolveFallbackBranchId(tenantId, preferredBranchId = null, client = null) {
  if (preferredBranchId) return preferredBranchId
  const run = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)
  const { rows } = await run(
    `
      SELECT id
      FROM branches
      WHERE tenant_id = $1
        AND (status IS NULL OR status = 'active' OR status = 'open')
      ORDER BY created_at ASC NULLS LAST
      LIMIT 1
    `,
    [],
  )
  return rows[0]?.id || null
}

/**
 * Write one Admin Logs row. Never throws into callers — audit failure is logged, business op stays.
 * When `client` is a shared txn: wrap in SAVEPOINT so a bad audit query cannot abort the
 * business transaction (PG "commands ignored until end of transaction block" → silent rollback).
 */
export async function writeAdminActivity(tenantId, payload = {}, client = null) {
  const sp = client ? `admin_log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` : null
  try {
    if (client && sp) {
      await client.query(`SAVEPOINT ${sp}`)
    }

    const actorUserId = payload.actorUserId || null
    let actorName = payload.actorName
    let actorRole = payload.actorRole
    if (!actorName) actorName = await lookupActorName(tenantId, actorUserId, client)
    if (!actorRole) actorRole = await lookupActorRole(tenantId, actorUserId, client)

    const source = payload.source || activitySourceFromRole(actorRole)
    const branchId =
      payload.branchId || (await resolveFallbackBranchId(tenantId, null, client))

    if (!branchId) {
      console.warn('[adminActivityLog] skip — branchId required', payload.action)
      if (client && sp) await client.query(`RELEASE SAVEPOINT ${sp}`)
      return null
    }

    const row = await logActivity(
      tenantId,
      {
        branchId,
        actorUserId,
        actorName,
        actorRole,
        source,
        category: payload.category,
        action: payload.action,
        entityType: payload.entityType || null,
        entityId: payload.entityId != null ? String(payload.entityId) : null,
        details: {
          ...(payload.details && typeof payload.details === 'object' ? payload.details : {}),
          ...(payload.actionText ? { actionText: payload.actionText } : {}),
          ...(payload.affectedItem ? { affectedItem: payload.affectedItem } : {}),
        },
      },
      client,
    )
    if (client && sp) await client.query(`RELEASE SAVEPOINT ${sp}`)
    return row
  } catch (err) {
    if (client && sp) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`)
        await client.query(`RELEASE SAVEPOINT ${sp}`)
      } catch (spErr) {
        console.error('[adminActivityLog] savepoint recovery failed', spErr?.message || spErr)
      }
    }
    console.error('[adminActivityLog] failed', payload.action, err?.message || err)
    return null
  }
}

/** Map ledger movement_type → activity action slug + category stock. */
export function stockActionFromMovement(movementType) {
  switch (movementType) {
    case MOVEMENT_TYPES.IN:
      return 'stock_in'
    case MOVEMENT_TYPES.OUT:
      return 'stock_out'
    case MOVEMENT_TYPES.ADJUSTMENT:
      return 'stock_adjustment'
    case MOVEMENT_TYPES.DAMAGED:
      return 'stock_damaged'
    case MOVEMENT_TYPES.EXPIRED:
      return 'stock_expired'
    case MOVEMENT_TYPES.TRANSFER:
      return 'stock_transfer'
    case MOVEMENT_TYPES.OTHER:
      return 'stock_other'
    default:
      return 'stock_adjustment'
  }
}

function productLabel(name, variantLabel) {
  const base = String(name || 'Product').trim() || 'Product'
  const variant = String(variantLabel || '').trim()
  return variant ? `${base} (${variant})` : base
}

/** Doc §5.1 Action strings + §5.9.3 order receival suffix. */
export function formatStockActionText({
  movementType,
  quantity,
  productName,
  variantLabel,
  newTotal,
  oldQty,
  orderId,
  orderNumber,
}) {
  const item = productLabel(productName, variantLabel)
  const qty = Math.abs(Number(quantity) || 0)
  const total = newTotal != null ? Number(newTotal) : null
  const orderRef = orderNumber || orderId
  const orderSuffix = orderRef ? ` Source: Order Receival ${orderRef}.` : ''

  switch (movementType) {
    case MOVEMENT_TYPES.IN:
      return `Added ${qty} units of ${item}. New stock: ${total ?? '—'}.${orderSuffix}`
    case MOVEMENT_TYPES.OUT:
      return `Removed ${qty} units of ${item}. New stock: ${total ?? '—'}.`
    case MOVEMENT_TYPES.DAMAGED:
      return `Recorded ${qty} damaged units of ${item}. Stock reduced to ${total ?? '—'}.`
    case MOVEMENT_TYPES.EXPIRED:
      return `Recorded ${qty} expired units of ${item}. Stock reduced to ${total ?? '—'}.`
    case MOVEMENT_TYPES.ADJUSTMENT:
      if (oldQty != null && total != null) {
        return `Adjusted stock of ${item} from ${oldQty} to ${total}.`
      }
      return `Adjusted stock of ${item} by ${Number(quantity) || 0}. New stock: ${total ?? '—'}.`
    case MOVEMENT_TYPES.TRANSFER:
      return `Transferred ${qty} units of ${item}.`
    default:
      return `Stock movement (${movementType}) of ${qty} units for ${item}. New stock: ${total ?? '—'}.`
  }
}
