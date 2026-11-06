import { tenantQuery } from '../../../config/db.js'
import {
  DEFAULT_CURRENCY,
  formatMoney as formatCurrencyMoney,
  normalizeCurrency,
} from '../../../utils/currency.util.js'

async function getTenantCurrency(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT COALESCE(default_currency, $2) AS "defaultCurrency"
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [DEFAULT_CURRENCY],
  )
  return normalizeCurrency(rows[0]?.defaultCurrency || DEFAULT_CURRENCY)
}

function mapInvoiceRow(row, currency = DEFAULT_CURRENCY) {
  if (!row) return null
  const billedAt = row.billedAt
  const d = billedAt instanceof Date ? billedAt : new Date(billedAt)
  const month = Number.isNaN(d.getTime())
    ? ''
    : String(d.getUTCMonth() + 1).padStart(2, '0')
  const year = Number.isNaN(d.getTime()) ? '' : String(d.getUTCFullYear())
  const price = Number(row.price) || 0
  let items = row.items
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items)
    } catch {
      items = []
    }
  }
  if (!Array.isArray(items)) items = []

  return {
    id: row.id,
    trackingId: row.trackingId || '',
    dateTime: formatDateTime(billedAt),
    billedAt: billedAt || null,
    month,
    year,
    price,
    currency,
    formattedPrice: formatCurrencyMoney(price, currency),
    source: row.source || '',
    status: row.status === 'paid' ? 'Paid' : String(row.status || 'pending'),
    billingCycle: row.billingCycle || '',
    paymentMethod: row.paymentMethod || '',
    items: items.map((item) => ({
      description: item?.description || item?.name || '',
      amount: Number(item?.amount) || 0,
    })),
  }
}

function formatDateTime(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  // Always 12-hour with AM/PM (matches client formatDateTime helper)
  return d
    .toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
    .replace(/\b(am|pm)\b/gi, (m) => m.toUpperCase())
}

export async function listInvoices(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit
  const q = filters.q?.trim() || null
  const month = filters.month ? Number(filters.month) : null
  const year = filters.year ? Number(filters.year) : null
  const currency = await getTenantCurrency(tenantId)

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM billing_invoices
      WHERE tenant_id = $1
        AND ($2::int IS NULL OR EXTRACT(MONTH FROM billed_at) = $2)
        AND ($3::int IS NULL OR EXTRACT(YEAR FROM billed_at) = $3)
        AND (
          $4::text IS NULL
          OR tracking_id ILIKE '%' || $4 || '%'
          OR source ILIKE '%' || $4 || '%'
          OR COALESCE(payment_method, '') ILIKE '%' || $4 || '%'
          OR COALESCE(billing_cycle, '') ILIKE '%' || $4 || '%'
        )
    `,
    [month, year, q],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        tracking_id AS "trackingId",
        billed_at AS "billedAt",
        price,
        COALESCE(currency, 'PKR') AS currency,
        source,
        status,
        billing_cycle AS "billingCycle",
        payment_method AS "paymentMethod",
        items
      FROM billing_invoices
      WHERE tenant_id = $1
        AND ($2::int IS NULL OR EXTRACT(MONTH FROM billed_at) = $2)
        AND ($3::int IS NULL OR EXTRACT(YEAR FROM billed_at) = $3)
        AND (
          $4::text IS NULL
          OR tracking_id ILIKE '%' || $4 || '%'
          OR source ILIKE '%' || $4 || '%'
          OR COALESCE(payment_method, '') ILIKE '%' || $4 || '%'
          OR COALESCE(billing_cycle, '') ILIKE '%' || $4 || '%'
        )
      ORDER BY billed_at DESC, tracking_id DESC
      LIMIT $5 OFFSET $6
    `,
    [month, year, q, limit, offset],
  )

  return {
    items: rows.map((row) => mapInvoiceRow(row, row.currency || currency)),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}

export async function getInvoiceById(tenantId, id) {
  const currency = await getTenantCurrency(tenantId)
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        tracking_id AS "trackingId",
        billed_at AS "billedAt",
        price,
        COALESCE(currency, 'PKR') AS currency,
        source,
        status,
        billing_cycle AS "billingCycle",
        payment_method AS "paymentMethod",
        items
      FROM billing_invoices
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [id],
  )
  return mapInvoiceRow(rows[0] || null, rows[0]?.currency || currency)
}

export async function getInvoicesSummary(tenantId) {
  const currency = await getTenantCurrency(tenantId)
  const [{ rows: subRows }, { rows: invRows }, { rows: branchRows }] = await Promise.all([
    tenantQuery(
      tenantId,
      `
        SELECT
          plan_name AS "planName",
          branch_limit AS "branchLimit",
          auto_pay AS "autoPay",
          next_renewal_at AS "nextRenewalAt",
          payment_method AS "paymentMethod",
          is_active AS "isActive"
        FROM tenant_subscriptions
        WHERE tenant_id = $1
        LIMIT 1
      `,
    ),
    tenantQuery(
      tenantId,
      `
        SELECT
          COALESCE(sum(price) FILTER (
            WHERE EXTRACT(YEAR FROM billed_at) = EXTRACT(YEAR FROM CURRENT_DATE)
          ), 0)::numeric AS "ytdTotal",
          count(*) FILTER (
            WHERE EXTRACT(YEAR FROM billed_at) = EXTRACT(YEAR FROM CURRENT_DATE)
          )::int AS "ytdCount",
          count(*)::int AS "totalCount"
        FROM billing_invoices
        WHERE tenant_id = $1
      `,
    ),
    tenantQuery(
      tenantId,
      `
        SELECT count(*)::int AS "branchCount"
        FROM branches
        WHERE tenant_id = $1
          AND status = 'open'
      `,
    ),
  ])

  const sub = subRows[0] || null
  const inv = invRows[0] || { ytdTotal: 0, ytdCount: 0, totalCount: 0 }
  const branches = branchRows[0]?.branchCount || 0
  const ytdTotal = Number(inv.ytdTotal) || 0

  return {
    planName: sub?.planName || null,
    branchLimit: sub?.branchLimit ?? null,
    branchCount: branches,
    autoPay: Boolean(sub?.autoPay),
    nextRenewalAt: sub?.nextRenewalAt || null,
    paymentMethod: sub?.paymentMethod || null,
    isActive: sub ? sub.isActive !== false : false,
    ytdTotal,
    currency,
    ytdFormatted: formatCurrencyMoney(ytdTotal, currency),
    ytdCount: inv.ytdCount || 0,
    totalCount: inv.totalCount || 0,
  }
}
