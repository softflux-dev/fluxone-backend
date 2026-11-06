import { tenantQuery } from '../../../config/db.js'
import {
  DEFAULT_CURRENCY,
  normalizeCurrency,
  SUPPORTED_CURRENCIES,
} from '../../../utils/currency.util.js'
import { conversionFactor } from '../../../utils/fx.util.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'

// Map assigned BM hardware → Admin System Access row
function mapDeviceRow(row) {
  if (!row) return null
  return {
    id: row.id,
    deviceName: row.deviceName || '',
    hardwareCode: row.hardwareCode || '',
    hardwareType: row.hardwareType || '',
    imageUrl: normalizeImageUrl(row.imageUrl) || null,
    // hardwareSignature removed — Hardware ID (HW-xxx) is the system identity
    userId: row.userEmail || '',
    userName: row.userName || 'Unassigned',
    employeeImageUrl: normalizeImageUrl(row.employeeImageUrl) || null,
    designation: row.designation || null,
    staffId: row.staffId || null,
    branchId: row.branchId || null,
    branch: row.branchName || 'Unassigned',
    status: row.status === 'blocked' ? 'blocked' : 'active',
    lastActiveAt: row.lastActiveAt || null,
    createdAt: row.createdAt || null,
  }
}

// Shared FROM/JOIN: only hardware currently assigned to a staff member
const ASSIGNED_HARDWARE_FROM = `
  FROM branch_hardware h
  INNER JOIN staff s
    ON s.tenant_id = h.tenant_id
   AND s.hardware_device_id = h.id::text
  INNER JOIN users u
    ON u.id = s.user_id
   AND u.tenant_id = s.tenant_id
  LEFT JOIN designations d
    ON d.id = s.designation_id
   AND d.tenant_id = s.tenant_id
  LEFT JOIN branches b
    ON b.id = h.branch_id
   AND b.tenant_id = h.tenant_id
`

const ASSIGNED_HARDWARE_SELECT = `
  h.id,
  h.name AS "deviceName",
  h.code AS "hardwareCode",
  h.type AS "hardwareType",
  h.image_url AS "imageUrl",
  h.branch_id AS "branchId",
  b.name AS "branchName",
  s.id AS "staffId",
  s.image_url AS "employeeImageUrl",
  COALESCE(d.name, s.designation) AS "designation",
  u.email AS "userEmail",
  u.full_name AS "userName",
  h.access_status AS status,
  h.created_at AS "lastActiveAt",
  h.created_at AS "createdAt"
`

export async function listDevices(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 6))
  const offset = (page - 1) * limit
  const q = filters.q?.trim() || null
  const status =
    filters.status && filters.status !== 'all' ? filters.status : null
  const branchId = filters.branchId || null
  const hardwareType =
    filters.type && filters.type !== 'all' ? String(filters.type).trim() : null

  // Stats mirror list scope (branch filter applies when set)
  const { rows: statsRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE h.access_status = 'active')::int AS active,
        count(*) FILTER (WHERE h.access_status = 'blocked')::int AS blocked
      ${ASSIGNED_HARDWARE_FROM}
      WHERE h.tenant_id = $1
        AND ($2::uuid IS NULL OR h.branch_id = $2)
        AND COALESCE(h.is_active, true) = true
    `,
    [branchId],
  )

  // clean and optimized code — search + status + hardware type filters
  const searchAndStatus = `
    AND COALESCE(h.is_active, true) = true
    AND ($3::text IS NULL OR h.access_status = $3)
    AND ($4::text IS NULL OR h.type = $4)
    AND (
      $5::text IS NULL
      OR h.name ILIKE '%' || $5 || '%'
      OR h.code ILIKE '%' || $5 || '%'
      OR h.type ILIKE '%' || $5 || '%'
      OR COALESCE(b.name, '') ILIKE '%' || $5 || '%'
      OR COALESCE(u.full_name, '') ILIKE '%' || $5 || '%'
      OR COALESCE(u.email, '') ILIKE '%' || $5 || '%'
    )
  `

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      ${ASSIGNED_HARDWARE_FROM}
      WHERE h.tenant_id = $1
        AND ($2::uuid IS NULL OR h.branch_id = $2)
        ${searchAndStatus}
    `,
    [branchId, status, hardwareType, q],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${ASSIGNED_HARDWARE_SELECT}
      ${ASSIGNED_HARDWARE_FROM}
      WHERE h.tenant_id = $1
        AND ($2::uuid IS NULL OR h.branch_id = $2)
        ${searchAndStatus}
      ORDER BY
        CASE WHEN h.access_status = 'active' THEN 0 ELSE 1 END,
        h.created_at DESC,
        h.name ASC
      LIMIT $6 OFFSET $7
    `,
    [branchId, status, hardwareType, q, limit, offset],
  )

  const stats = statsRows[0] || { total: 0, active: 0, blocked: 0 }
  return {
    items: rows.map(mapDeviceRow),
    total: countRows[0]?.total || 0,
    active: stats.active || 0,
    blocked: stats.blocked || 0,
    registered: stats.total || 0,
    page,
    limit,
  }
}

export async function updateDeviceStatus(tenantId, id, status) {
  // Block / authorize BM-assigned hardware (shared with branch manager)
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE branch_hardware
      SET access_status = $2
      WHERE tenant_id = $1
        AND id = $3
      RETURNING id
    `,
    [status, id],
  )

  if (!rows[0]) {
    const error = new Error('Device not found')
    error.status = 404
    throw error
  }

  const { rows: full } = await tenantQuery(
    tenantId,
    `
      SELECT ${ASSIGNED_HARDWARE_SELECT}
      ${ASSIGNED_HARDWARE_FROM}
      WHERE h.tenant_id = $1 AND h.id = $2
      LIMIT 1
    `,
    [id],
  )

  // Device may exist but be unassigned — still return a minimal row
  if (full[0]) return mapDeviceRow(full[0])

  const { rows: bare } = await tenantQuery(
    tenantId,
    `
      SELECT
        h.id,
        h.name AS "deviceName",
        h.code AS "hardwareCode",
        h.type AS "hardwareType",
        h.image_url AS "imageUrl",
        h.branch_id AS "branchId",
        b.name AS "branchName",
        NULL::uuid AS "staffId",
        NULL::text AS "employeeImageUrl",
        NULL::text AS "designation",
        NULL::text AS "userEmail",
        'Unassigned'::text AS "userName",
        h.access_status AS status,
        h.created_at AS "lastActiveAt",
        h.created_at AS "createdAt"
      FROM branch_hardware h
      LEFT JOIN branches b ON b.id = h.branch_id AND b.tenant_id = h.tenant_id
      WHERE h.tenant_id = $1 AND h.id = $2
      LIMIT 1
    `,
    [id],
  )

  return mapDeviceRow(bare[0])
}

// Tenant default currency (display default across the company)
export async function getRatesToPkr(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT currency_code AS code, rate_to_pkr::float8 AS rate
      FROM exchange_rates
      WHERE tenant_id = $1
    `,
  )
  const rates = { [DEFAULT_CURRENCY]: 1 }
  for (const row of rows) {
    rates[normalizeCurrency(row.code)] = Number(row.rate) || 1
  }
  return rates
}

export async function upsertRateToPkr(tenantId, currencyCode, rateToPkr) {
  const code = normalizeCurrency(currencyCode)
  const rate = code === DEFAULT_CURRENCY ? 1 : Number(rateToPkr)
  if (!Number.isFinite(rate) || rate <= 0) {
    const error = new Error('Exchange rate must be a positive number (PKR per 1 unit)')
    error.status = 422
    throw error
  }

  await tenantQuery(
    tenantId,
    `
      INSERT INTO exchange_rates (tenant_id, currency_code, rate_to_pkr)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, currency_code)
      DO UPDATE SET
        rate_to_pkr = EXCLUDED.rate_to_pkr,
        created_at = now()
    `,
    [code, rate],
  )
  return rate
}

async function convertProductPrices(tenantId, fromCurrency, toCurrency, ratesToPkr) {
  const factor = conversionFactor(fromCurrency, toCurrency, ratesToPkr)
  if (factor === 1) return 0

  const { rowCount } = await tenantQuery(
    tenantId,
    `
      UPDATE products
      SET
        selling_price = ROUND(selling_price * $2::numeric, 2),
        purchase_price = ROUND(purchase_price * $2::numeric, 2),
        last_selling_price = CASE
          WHEN last_selling_price IS NULL THEN NULL
          ELSE ROUND(last_selling_price * $2::numeric, 2)
        END,
        price_currency = $3,
        updated_at = now()
      WHERE tenant_id = $1
    `,
    [factor, normalizeCurrency(toCurrency)],
  )
  return rowCount || 0
}

export async function getCurrencySettings(tenantId) {
  const [{ rows }, ratesToPkr] = await Promise.all([
    tenantQuery(
      tenantId,
      `
        SELECT
          COALESCE(default_currency, $2) AS "defaultCurrency",
          COALESCE(currency_locked, false) AS "currencyLocked"
        FROM tenants
        WHERE id = $1
        LIMIT 1
      `,
      [DEFAULT_CURRENCY],
    ),
    getRatesToPkr(tenantId),
  ])

  return {
    defaultCurrency: normalizeCurrency(rows[0]?.defaultCurrency || DEFAULT_CURRENCY),
    currencyLocked: Boolean(rows[0]?.currencyLocked),
    options: SUPPORTED_CURRENCIES,
    ratesToPkr,
  }
}

export async function updateCurrencySettings(tenantId, { defaultCurrency, rateToPkr }, userId = null) {
  const next = normalizeCurrency(defaultCurrency)
  const current = await getCurrencySettings(tenantId)
  const from = current.defaultCurrency

  // After first save, currency settings are immutable via API (Supabase-only for now)
  if (current.currencyLocked) {
    const error = new Error(
      'Currency settings are locked after the first save. Contact support or update via database if a change is required.',
    )
    error.status = 403
    throw error
  }

  // Persist latest rate for the selected currency (1 USD = rateToPkr PKR)
  const resolvedRate =
    next === DEFAULT_CURRENCY
      ? 1
      : rateToPkr != null && rateToPkr !== ''
        ? Number(rateToPkr)
        : current.ratesToPkr[next]

  if (next !== DEFAULT_CURRENCY && (!Number.isFinite(Number(resolvedRate)) || Number(resolvedRate) <= 0)) {
    const error = new Error(`Enter how many PKR equal 1 ${next} (e.g. 1 ${next} = 230 PKR)`)
    error.status = 422
    throw error
  }

  await upsertRateToPkr(tenantId, next, resolvedRate)
  // Keep PKR anchor
  await upsertRateToPkr(tenantId, DEFAULT_CURRENCY, 1)

  const ratesToPkr = await getRatesToPkr(tenantId)
  let productsConverted = 0

  if (from !== next) {
    productsConverted = await convertProductPrices(tenantId, from, next, ratesToPkr)

    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE tenants
        SET default_currency = $2
        WHERE id = $1
        RETURNING COALESCE(default_currency, $3) AS "defaultCurrency"
      `,
      [next, DEFAULT_CURRENCY],
    )

    if (!rows[0]) {
      const error = new Error('Company not found')
      error.status = 404
      throw error
    }

    await tenantQuery(
      tenantId,
      `
        INSERT INTO currency_change_events (
          tenant_id, from_currency, to_currency, rate_to_pkr, products_converted, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [from, next, ratesToPkr[next] ?? resolvedRate, productsConverted, userId],
    )
  }

  // First successful Admin Save locks default currency permanently (API)
  if (!current.currencyLocked) {
    await tenantQuery(
      tenantId,
      `
        UPDATE tenants
        SET currency_locked = true
        WHERE id = $1
      `,
      [],
    )
  }

  const refreshed = await getCurrencySettings(tenantId)
  return {
    ...refreshed,
    productsConverted,
    currencyChanged: from !== next,
    fromCurrency: from,
  }
}
