/** Shared WHERE fragments for Admin Logs list + export (Phase 4/5 tab filters). */

/** Max inclusive calendar span for Admin Logs queries (large-range guard). */
export const ADMIN_LOGS_MAX_RANGE_DAYS = 366

/** Settings tab — map UI settingCategory → action slugs. */
export const SETTING_CATEGORY_ACTIONS = Object.freeze({
  branch_settings: ['branch_settings_update', 'branch_status'],
  tax_configuration: ['tax_profit_defaults'],
  policy: ['policy_create', 'policy_update', 'policy_delete'],
  // No notification-settings writers yet — empty → force zero matches (Phase 5)
  notification: [],
  other: [
    'currency_settings',
    'company_settings',
    'offer_create',
    'offer_update',
    'offer_delete',
  ],
})

/** Sentinel action that never exists — used when a filter category has no writers. */
const EMPTY_ACTION_SENTINEL = '__no_matching_action__'

function startOfLocalDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function endOfLocalDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(23, 59, 59, 999)
  return d
}

/**
 * Normalize list filters into SQL params (after tenant_id $1).
 * Defaults missing dates to Today; callers should still validate max range.
 * @returns {{ params: unknown[], whereSql: string, limit: number, offset: number, page: number }}
 */
export function buildAdminLogsListQuery(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(200, Math.max(1, Number(filters.limit) || 25))
  const offset = (page - 1) * limit

  // Snapshot safety — unbounded date scans are expensive; default to Today
  let from = filters.from || null
  let to = filters.to || null
  if (!from && !to) {
    from = startOfLocalDay()
    to = endOfLocalDay()
  }

  let categories = null
  if (Array.isArray(filters.categories) && filters.categories.length > 0) {
    categories = filters.categories
  } else if (filters.category) {
    categories = [filters.category]
  }

  let actionSlugs = null
  if (Array.isArray(filters.actions) && filters.actions.length > 0) {
    actionSlugs = filters.actions
  } else if (filters.settingCategory && SETTING_CATEGORY_ACTIONS[filters.settingCategory] !== undefined) {
    const mapped = SETTING_CATEGORY_ACTIONS[filters.settingCategory]
    actionSlugs = mapped.length ? mapped : [EMPTY_ACTION_SENTINEL]
  } else if (filters.action) {
    actionSlugs = [filters.action]
  }

  const params = [
    filters.branchId || null,
    from,
    to,
    categories,
    filters.actorRole || null,
    filters.actorUserId || null,
    actionSlugs,
    filters.source || null,
    filters.q || null,
    filters.entityId || null,
    filters.productType || null,
    filters.variantTypeId || null,
    filters.supplierId || null,
    filters.orderStatus || null,
    filters.ids?.length ? filters.ids : null,
  ]

  const whereSql = `
    WHERE al.tenant_id = $1
      AND ($2::uuid IS NULL OR al.branch_id = $2)
      AND ($3::timestamptz IS NULL OR al.created_at >= $3)
      AND ($4::timestamptz IS NULL OR al.created_at <= $4)
      AND ($5::text[] IS NULL OR al.category = ANY($5::text[]))
      AND ($6::text IS NULL OR al.actor_role = $6)
      AND ($7::uuid IS NULL OR al.actor_user_id = $7)
      AND ($8::text[] IS NULL OR al.action = ANY($8::text[]))
      AND ($9::text IS NULL OR al.source = $9)
      AND (
        $10::text IS NULL
        OR al.actor_name ILIKE '%' || $10 || '%'
        OR al.action ILIKE '%' || $10 || '%'
        OR COALESCE(al.details->>'actionText', '') ILIKE '%' || $10 || '%'
        OR COALESCE(b.name, '') ILIKE '%' || $10 || '%'
        OR COALESCE(al.entity_id, '') ILIKE '%' || $10 || '%'
        OR COALESCE(al.details->>'orderNumber', '') ILIKE '%' || $10 || '%'
      )
      AND ($11::text IS NULL OR al.entity_id = $11::text)
      AND (
        $12::text IS NULL
        OR (
          al.entity_type = 'product'
          AND EXISTS (
            SELECT 1
            FROM products p
            WHERE p.tenant_id = al.tenant_id
              AND p.id::text = al.entity_id
              AND (
                ($12 = 'normal' AND p.type = 'single')
                OR ($12 = 'variant' AND p.type = 'variant')
              )
          )
        )
      )
      AND (
        $13::uuid IS NULL
        OR (al.entity_type = 'variant_type' AND al.entity_id = $13::text)
        OR (al.details->>'variantTypeId') = $13::text
      )
      AND (
        $14::uuid IS NULL
        OR (al.entity_type = 'supplier' AND al.entity_id = $14::text)
        OR (al.details->>'supplierId') = $14::text
      )
      AND (
        $15::text IS NULL
        OR COALESCE(al.details->>'orderStatus', al.details->>'status', '') = $15
      )
      AND ($16::uuid[] IS NULL OR al.id = ANY($16::uuid[]))
  `

  return { params, whereSql, limit, offset, page }
}
