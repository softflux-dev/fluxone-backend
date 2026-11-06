import { tenantClientQuery, tenantQuery } from '../config/db.js'

export const ACTIVITY_SOURCES = Object.freeze(['pos', 'bm', 'im', 'system'])

/** Admin Logs categories — docs/Admin Logs Module.md §2.1 (All Activity is UI-only). */
export const ACTIVITY_CATEGORIES = Object.freeze([
  'stock',
  'pricing',
  'products',
  'bundles',
  'variants',
  'employees',
  'settings',
  'hardware',
  'orders_suppliers',
])

/** action slug → category when writer omits category (legacy POS + gradual rollout). */
const ACTION_CATEGORY = Object.freeze({
  stock_in: 'stock',
  stock_out: 'stock',
  stock_adjustment: 'stock',
  stock_damaged: 'stock',
  stock_expired: 'stock',
  stock_transfer: 'stock',
  stock_other: 'stock',
  sale: 'stock',
  refund: 'stock',
  price_change: 'pricing',
  selling_price_change: 'pricing',
  purchase_price_change: 'pricing',
  offer_apply: 'pricing',
  offer_remove: 'pricing',
  daily_price_change: 'pricing',
  product_create: 'products',
  product_update: 'products',
  product_deactivate: 'products',
  product_reactivate: 'products',
  product_delete: 'products',
  variant_combination_add: 'products',
  variant_combination_deactivate: 'products',
  bundle_create: 'bundles',
  bundle_top_up: 'bundles',
  bundle_deactivate: 'bundles',
  bundle_delete: 'bundles',
  bundle_price_change: 'bundles',
  variant_type_create: 'variants',
  variant_type_update: 'variants',
  variant_type_delete: 'variants',
  variant_value_create: 'variants',
  variant_value_update: 'variants',
  variant_value_delete: 'variants',
  staff_create: 'employees',
  staff_update: 'employees',
  staff_role_change: 'employees',
  staff_status: 'employees',
  staff_delete: 'employees',
  branch_settings_update: 'settings',
  branch_status: 'settings',
  tax_profit_defaults: 'settings',
  policy_create: 'settings',
  policy_update: 'settings',
  policy_delete: 'settings',
  offer_create: 'settings',
  offer_update: 'settings',
  offer_delete: 'settings',
  currency_settings: 'settings',
  company_settings: 'settings',
  hardware_register: 'hardware',
  hardware_update: 'hardware',
  hardware_remove: 'hardware',
  hardware_status: 'hardware',
  device_status: 'hardware',
  supplier_create: 'orders_suppliers',
  supplier_update: 'orders_suppliers',
  supplier_block: 'orders_suppliers',
  supplier_unblock: 'orders_suppliers',
  supplier_delete: 'orders_suppliers',
  order_generate: 'orders_suppliers',
  order_edit: 'orders_suppliers',
  order_approve: 'orders_suppliers',
  order_reject: 'orders_suppliers',
  order_cancel: 'orders_suppliers',
  order_receival: 'orders_suppliers',
  order_complete: 'orders_suppliers',
  invoice_generate: 'orders_suppliers',
  invoice_send: 'orders_suppliers',
  login: 'settings',
  logout: 'settings',
  open_cash_drawer: 'settings',
  close_cash_drawer: 'settings',
  change_cashier: 'employees',
})

/** Known action slugs → verb phrase for TL sentence: "{Name} {verb}" */
const ACTION_VERBS = Object.freeze({
  login: 'logged in',
  logout: 'logged out',
  open_cash_drawer: 'opened the cash drawer',
  close_cash_drawer: 'closed the cash drawer',
  price_change: 'changed a price',
  change_cashier: 'changed cashier',
  stock_in: 'performed stock in',
  stock_out: 'performed stock out',
  stock_adjustment: 'adjusted stock',
  stock_damaged: 'recorded damaged stock',
  stock_expired: 'recorded expired stock',
  staff_create: 'created staff',
  staff_update: 'updated staff',
  staff_delete: 'deleted staff',
  order_generate: 'generated a purchase order',
  order_approve: 'approved a purchase order',
  order_reject: 'rejected a purchase order',
  order_receival: 'recorded order receival',
  sale: 'completed a sale',
  refund: 'processed a refund',
  product_create: 'added a product',
  product_update: 'edited a product',
  bundle_create: 'created a bundle',
  supplier_create: 'created a supplier',
  hardware_register: 'registered a device',
})

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Resolve category from explicit payload or action slug map. */
export function resolveActivityCategory(category, action) {
  const explicit = String(category || '').trim()
  if (explicit) {
    if (!ACTIVITY_CATEGORIES.includes(explicit)) {
      throw httpError(400, `category must be one of: ${ACTIVITY_CATEGORIES.join(', ')}`)
    }
    return explicit
  }
  const slug = String(action || '').trim()
  return ACTION_CATEGORY[slug] || 'settings'
}

/**
 * Human Action column (Admin Logs §5).
 * Prefer details.actionText / details.summary; else "{Name} {verb}".
 */
export function formatActivityMessage(actorName, action, details = {}) {
  const custom =
    (details && (details.actionText || details.summary || details.message)) || null
  if (custom && String(custom).trim()) return String(custom).trim()

  const name = String(actorName || 'Someone').trim() || 'Someone'
  const slug = String(action || '').trim()
  const verb = ACTION_VERBS[slug] || `performed ${slug || 'an action'}`
  return `${name} ${verb}`
}

/** Affected Item column — from details or entity fallback. */
export function formatAffectedItem(details = {}, entityType = null, entityId = null) {
  if (details?.affectedItem != null && String(details.affectedItem).trim()) {
    return String(details.affectedItem).trim()
  }
  if (details?.itemName != null && String(details.itemName).trim()) {
    return String(details.itemName).trim()
  }
  if (entityType || entityId) {
    const parts = [entityType, entityId].filter(Boolean)
    return parts.join(' ')
  }
  return null
}

/**
 * Insert one activity_logs row. Shared by BM / IM / POS ingest / system writers.
 * Immutable audit: APPEND ONLY — never UPDATE or DELETE activity_logs rows from app code.
 *
 * @param {string} tenantId
 * @param {object} payload
 * @param {string} payload.branchId
 * @param {string|null} [payload.actorUserId]
 * @param {string} payload.actorName
 * @param {string} [payload.actorRole]
 * @param {string} payload.action
 * @param {'pos'|'bm'|'im'|'system'} payload.source
 * @param {string} [payload.category] - Admin Logs tab category; inferred from action if omitted
 * @param {string} [payload.entityType]
 * @param {string} [payload.entityId]
 * @param {object} [payload.details] - may include actionText / affectedItem for Admin UI
 * @param {Date|string} [payload.createdAt]
 * @param {string} [payload.posEventId]
 * @param {string} [payload.clientEventId]
 * @param {import('pg').PoolClient} [client] - optional txn client (tenantClientQuery)
 * @returns {Promise<object>} inserted row (camelCase)
 */
export async function logActivity(tenantId, payload = {}, client = null) {
  const branchId = payload.branchId
  if (!branchId) throw httpError(400, 'branchId is required for activity log')

  const actorName = String(payload.actorName || '').trim()
  if (!actorName) throw httpError(400, 'actorName is required for activity log')

  const action = String(payload.action || '').trim()
  if (!action) throw httpError(400, 'action is required for activity log')

  const source = String(payload.source || '').trim()
  if (!ACTIVITY_SOURCES.includes(source)) {
    throw httpError(400, `source must be one of: ${ACTIVITY_SOURCES.join(', ')}`)
  }

  const category = resolveActivityCategory(payload.category, action)

  const actorRole = String(payload.actorRole || 'unknown').trim() || 'unknown'
  const details =
    payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
      ? payload.details
      : {}

  const run = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)

  const { rows } = await run(
    `
      INSERT INTO activity_logs (
        tenant_id,
        branch_id,
        source,
        actor_user_id,
        actor_name,
        actor_role,
        action,
        category,
        entity_type,
        entity_id,
        details,
        pos_event_id,
        client_event_id,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
        COALESCE($14::timestamptz, now())
      )
      RETURNING
        id,
        branch_id AS "branchId",
        source,
        actor_user_id AS "actorUserId",
        actor_name AS "actorName",
        actor_role AS "actorRole",
        action,
        category,
        entity_type AS "entityType",
        entity_id AS "entityId",
        details,
        pos_event_id AS "posEventId",
        client_event_id AS "clientEventId",
        created_at AS "createdAt"
    `,
    [
      branchId,
      source,
      payload.actorUserId || null,
      actorName,
      actorRole,
      action,
      category,
      payload.entityType || null,
      payload.entityId != null ? String(payload.entityId) : null,
      JSON.stringify(details),
      payload.posEventId || null,
      payload.clientEventId || null,
      payload.createdAt || null,
    ],
  )

  const row = rows[0]
  return {
    ...row,
    message: formatActivityMessage(row.actorName, row.action, row.details),
    affectedItem: formatAffectedItem(row.details, row.entityType, row.entityId),
  }
}
