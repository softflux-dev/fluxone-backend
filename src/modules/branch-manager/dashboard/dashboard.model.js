import { pool, requireTenantId, tenantQuery } from '../../../config/db.js'
import { LATEST_EVALUATION_SCORE_SQL } from '../performance/performance.model.js'

// Latest append-only evaluation total % (0 when never scored)
const WEIGHTED_RATING_SQL = LATEST_EVALUATION_SCORE_SQL

function toDateParam(value) {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function scopeParams(filters = {}, { defaultToday = false } = {}) {
  let from = toDateParam(filters.from)
  let to = toDateParam(filters.to)
  const date = toDateParam(filters.date)

  if (!from && !to && date) {
    from = date
    to = date
  }

  if (defaultToday && !from && !to) {
    const today = todayIso()
    from = today
    to = today
  }

  return {
    from,
    to,
    branchId: filters.branchId || null,
  }
}

function shiftDate(isoDate, dayDelta) {
  const d = new Date(`${isoDate}T12:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + dayDelta)
  return d.toISOString().slice(0, 10)
}

function previousRange(from, to) {
  if (!from || !to) return { from: null, to: null }
  const fromMs = Date.parse(`${from}T12:00:00.000Z`)
  const toMs = Date.parse(`${to}T12:00:00.000Z`)
  const days = Math.max(1, Math.round((toMs - fromMs) / 86_400_000) + 1)
  const prevTo = shiftDate(from, -1)
  const prevFrom = shiftDate(prevTo, -(days - 1))
  return { from: prevFrom, to: prevTo }
}

function pctChange(current, previous) {
  const c = Number(current) || 0
  const p = Number(previous) || 0
  if (p === 0) return c > 0 ? 100 : 0
  return Math.round(((c - p) / p) * 1000) / 10
}

async function withTenantClient(tenantId, work) {
  const scopedTenantId = requireTenantId(tenantId)
  const client = await pool.connect()
  try {
    return await work(client, scopedTenantId)
  } finally {
    client.release()
  }
}

async function clientQuery(client, text, params = []) {
  return client.query(text, params)
}

async function salesTotals(tenantId, { from, to, branchId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        count(*)::int AS "saleCount",
        COALESCE(sum(final_amount), 0)::numeric AS "totalSales",
        COALESCE(sum(final_amount - return_amount), 0)::numeric AS "netSales",
        COALESCE(sum(return_amount), 0)::numeric AS "totalReturns",
        COALESCE(sum(discount_amount), 0)::numeric AS "totalDiscount",
        COALESCE(sum(tax_amount), 0)::numeric AS "totalTax",
        COALESCE(sum(paid_amount), 0)::numeric AS "totalPaid"
      FROM sales
      WHERE tenant_id = $1
        AND status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR sold_at::date >= $2::date)
        AND ($3::date IS NULL OR sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR branch_id = $4)
    `,
    [from, to, branchId],
  )
  return rows[0]
}

async function itemsSoldTotal(tenantId, { from, to, branchId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT COALESCE(sum(si.quantity), 0)::numeric AS "itemsSold"
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
    `,
    [from, to, branchId],
  )
  return Number(rows[0]?.itemsSold || 0)
}

async function productExtremes(tenantId, { from, to, branchId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id AS "productId",
        p.name AS "productName",
        sum(si.quantity)::numeric AS quantity,
        sum(si.line_total)::numeric AS revenue
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND si.is_exchange = false
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
      GROUP BY p.id, p.name
      ORDER BY revenue DESC, quantity DESC
    `,
    [from, to, branchId],
  )

  if (!rows.length) {
    return { highestSalesProduct: null, lowestSalesProduct: null }
  }

  return {
    highestSalesProduct: rows[0],
    lowestSalesProduct: rows[rows.length - 1],
  }
}

async function peakHours(tenantId, { from, to, branchId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        extract(hour FROM sold_at)::int AS hour,
        count(*)::int AS "saleCount",
        COALESCE(sum(final_amount), 0)::numeric AS revenue
      FROM sales
      WHERE tenant_id = $1
        AND status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR sold_at::date >= $2::date)
        AND ($3::date IS NULL OR sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR branch_id = $4)
      GROUP BY hour
      ORDER BY revenue DESC, "saleCount" DESC
      LIMIT 5
    `,
    [from, to, branchId],
  )
  return rows
}

async function counterBreakdown(tenantId, { from, to, branchId }) {
  // Prefer POS till name/code; never expose raw hardware UUID in the UI label
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        COALESCE(
          c.id::text,
          'hw:' || COALESCE(NULLIF(TRIM(hw.code), ''), NULLIF(hw.id::text, ''), 'unassigned')
        ) AS "counterId",
        COALESCE(
          NULLIF(TRIM(c.code), ''),
          NULLIF(TRIM(hw.code), ''),
          'UNASSIGNED'
        ) AS "counterCode",
        COALESCE(
          NULLIF(TRIM(c.name), ''),
          NULLIF(TRIM(c.code), ''),
          NULLIF(TRIM(hw.name), ''),
          NULLIF(TRIM(hw.code), ''),
          'Unassigned till'
        ) AS "counterName",
        count(s.id)::int AS "saleCount",
        COALESCE(sum(s.final_amount), 0)::numeric AS revenue
      FROM sales s
      LEFT JOIN pos_counters c ON c.id = s.counter_id AND c.tenant_id = s.tenant_id
      LEFT JOIN staff st ON st.id = s.staff_id AND st.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = NULLIF(TRIM(st.hardware_device_id), '')
      WHERE s.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
      GROUP BY c.id, c.code, c.name, hw.id, hw.code, hw.name
      ORDER BY revenue DESC
    `,
    [from, to, branchId],
  )
  return rows
}

export async function getBranchOverview(tenantId, filters = {}) {
  const scope = scopeParams(filters)
  const [totals, itemsSold, extremes, peaks, counters] = await Promise.all([
    salesTotals(tenantId, scope),
    itemsSoldTotal(tenantId, scope),
    productExtremes(tenantId, scope),
    peakHours(tenantId, scope),
    counterBreakdown(tenantId, scope),
  ])

  return {
    range: { from: scope.from, to: scope.to, branchId: scope.branchId },
    dailySalesSummary: {
      saleCount: totals.saleCount,
      totalSales: Number(totals.totalSales),
      netSales: Number(totals.netSales),
      totalReturns: Number(totals.totalReturns),
      totalDiscount: Number(totals.totalDiscount),
      totalTax: Number(totals.totalTax),
      totalPaid: Number(totals.totalPaid),
      itemsSold,
    },
    highestSalesProduct: extremes.highestSalesProduct,
    lowestSalesProduct: extremes.lowestSalesProduct,
    timePeaks: peaks,
    perCounterSales: counters,
  }
}

export async function getDailySalesSummary(tenantId, filters = {}) {
  const overview = await getBranchOverview(tenantId, filters)
  return overview.dailySalesSummary
}

export async function getSalesGraphData(tenantId, filters = {}) {
  const scope = scopeParams(filters)

  const [{ rows: salesByHour }, { rows: itemsByProduct }, { rows: salesByDay }] = await Promise.all([
    tenantQuery(
      tenantId,
      `
        SELECT
          extract(hour FROM sold_at)::int AS hour,
          count(*)::int AS "saleCount",
          COALESCE(sum(final_amount), 0)::numeric AS revenue
        FROM sales
        WHERE tenant_id = $1
          AND status IN ('completed', 'partial_refund')
          AND ($2::date IS NULL OR sold_at::date >= $2::date)
          AND ($3::date IS NULL OR sold_at::date <= $3::date)
          AND ($4::uuid IS NULL OR branch_id = $4)
        GROUP BY hour
        ORDER BY hour ASC
      `,
      [scope.from, scope.to, scope.branchId],
    ),
    tenantQuery(
      tenantId,
      `
        SELECT
          p.id AS "productId",
          p.name AS "productName",
          sum(si.quantity)::numeric AS quantity,
          sum(si.line_total)::numeric AS revenue
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
        JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
        WHERE si.tenant_id = $1
          AND s.status IN ('completed', 'partial_refund')
          AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
          AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
          AND ($4::uuid IS NULL OR s.branch_id = $4)
        GROUP BY p.id, p.name
        ORDER BY revenue DESC
        LIMIT 15
      `,
      [scope.from, scope.to, scope.branchId],
    ),
    tenantQuery(
      tenantId,
      `
        SELECT
          sold_at::date AS day,
          count(*)::int AS "saleCount",
          COALESCE(sum(final_amount), 0)::numeric AS revenue
        FROM sales
        WHERE tenant_id = $1
          AND status IN ('completed', 'partial_refund')
          AND ($2::date IS NULL OR sold_at::date >= $2::date)
          AND ($3::date IS NULL OR sold_at::date <= $3::date)
          AND ($4::uuid IS NULL OR branch_id = $4)
        GROUP BY day
        ORDER BY day ASC
      `,
      [scope.from, scope.to, scope.branchId],
    ),
  ])

  return {
    range: { from: scope.from, to: scope.to, branchId: scope.branchId },
    salesByHour,
    salesByDay,
    topItems: itemsByProduct,
  }
}

export async function listStaffPerformanceSnapshot(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit
  const branchId = filters.branchId || null

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM staff s
      WHERE s.tenant_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2)
    `,
    [branchId],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        s.id,
        u.full_name AS "fullName",
        s.image_url AS "imageUrl",
        s.status,
        ${WEIGHTED_RATING_SQL} AS "rating",
        COALESCE((
          SELECT SUM(lp.points)::numeric
          FROM (
            SELECT DISTINCT ON (ps.scale_id) ps.points
            FROM performance_scores ps
            INNER JOIN scoring_scales ss_live
              ON ss_live.id = ps.scale_id AND ss_live.tenant_id = ps.tenant_id
            WHERE ps.staff_id = s.id AND ps.tenant_id = s.tenant_id
            ORDER BY ps.scale_id, ps.scored_on DESC, ps.id DESC
          ) lp
        ), 0) AS "pointsRaw"
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2)
      ORDER BY "rating" DESC, u.full_name ASC
      LIMIT $3 OFFSET $4
    `,
    [branchId, limit, offset],
  )

  return {
    items: rows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      imageUrl: row.imageUrl,
      status: row.status,
      rating: Number(row.rating) || 0,
      points: Number(row.rating) || 0,
      pointsRaw: Number(row.pointsRaw) || 0,
    })),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}

export async function getInventoryStatusChart(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit
  const branchId = filters.branchId || null

  if (branchId) {
    const { rows: countRows } = await tenantQuery(
      tenantId,
      `
        SELECT count(*)::int AS total
        FROM products p
        LEFT JOIN branch_inventory bi
          ON bi.tenant_id = p.tenant_id
          AND bi.product_id = p.id
          AND bi.branch_id = $2
        WHERE p.tenant_id = $1
      `,
      [branchId],
    )

    const { rows } = await tenantQuery(
      tenantId,
      `
        SELECT
          p.id AS "productId",
          p.name AS "productName",
          p.item_code AS "itemCode",
          COALESCE(bi.quantity, 0)::numeric AS "remainingStock",
          p.reorder_point AS "reorderPoint",
          CASE
            WHEN COALESCE(bi.quantity, 0) <= 0 THEN 'red'
            WHEN COALESCE(bi.quantity, 0) <= p.reorder_point THEN 'yellow'
            ELSE 'green'
          END AS status
        FROM products p
        LEFT JOIN branch_inventory bi
          ON bi.tenant_id = p.tenant_id
          AND bi.product_id = p.id
          AND bi.branch_id = $2
        WHERE p.tenant_id = $1
        ORDER BY "remainingStock" ASC, p.name ASC
        LIMIT $3 OFFSET $4
      `,
      [branchId, limit, offset],
    )

    return {
      items: rows,
      chart: rows.map((row) => ({
        label: row.productName,
        value: Number(row.remainingStock),
        status: row.status,
      })),
      total: countRows[0]?.total || 0,
      page,
      limit,
    }
  }

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `SELECT count(*)::int AS total FROM products WHERE tenant_id = $1`,
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id AS "productId",
        p.name AS "productName",
        p.item_code AS "itemCode",
        p.quantity::numeric AS "remainingStock",
        p.reorder_point AS "reorderPoint",
        CASE
          WHEN p.quantity <= 0 THEN 'red'
          WHEN p.quantity <= p.reorder_point THEN 'yellow'
          ELSE 'green'
        END AS status
      FROM products p
      WHERE p.tenant_id = $1
      ORDER BY p.quantity ASC, p.name ASC
      LIMIT $2 OFFSET $3
    `,
    [limit, offset],
  )

  return {
    items: rows,
    chart: rows.map((row) => ({
      label: row.productName,
      value: Number(row.remainingStock),
      status: row.status,
    })),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}

async function getDashboardStaff(tenantId, branchId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        s.id,
        u.full_name AS "name",
        s.image_url AS "image",
        s.status,
        d.name AS "role",
        ${WEIGHTED_RATING_SQL} AS "rating",
        COALESCE((
          SELECT SUM(lp.points)::numeric
          FROM (
            SELECT DISTINCT ON (ps.scale_id) ps.points
            FROM performance_scores ps
            INNER JOIN scoring_scales ss_live
              ON ss_live.id = ps.scale_id AND ss_live.tenant_id = ps.tenant_id
            WHERE ps.staff_id = s.id AND ps.tenant_id = s.tenant_id
            ORDER BY ps.scale_id, ps.scored_on DESC, ps.id DESC
          ) lp
        ), 0) AS "pointsRaw"
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2)
      ORDER BY "rating" DESC, u.full_name ASC
    `,
    [branchId],
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    image: row.image,
    status: row.status,
    role: row.role,
    rating: Number(row.rating) || 0,
    // Keep `points` as score rating % so Staff List matches Performance tab
    points: Number(row.rating) || 0,
    pointsRaw: Number(row.pointsRaw) || 0,
  }))
}

async function getDashboardInventory(tenantId, branchId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.name,
        COALESCE(bi.quantity, 0)::int AS stock,
        GREATEST(
          COALESCE(bi.quantity, 0),
          COALESCE(p.reorder_point, 10) * 4,
          1
        )::int AS capacity,
        CASE
          WHEN COALESCE(bi.quantity, 0) <= 0 THEN 'critical'
          WHEN COALESCE(bi.quantity, 0) <= p.reorder_point THEN 'low'
          ELSE 'in_stock'
        END AS status
      FROM products p
      LEFT JOIN branch_inventory bi
        ON bi.tenant_id = p.tenant_id
        AND bi.product_id = p.id
        AND ($2::uuid IS NULL OR bi.branch_id = $2)
      WHERE p.tenant_id = $1
      ORDER BY stock ASC, p.name ASC
      LIMIT 10
    `,
    [branchId],
  )
  return rows
}

async function getDashboardProducts(tenantId, { from, to, branchId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id,
        p.name,
        sum(si.quantity)::int AS units,
        sum(si.line_total)::numeric AS sales
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
      GROUP BY p.id, p.name
      ORDER BY units DESC, sales DESC
    `,
    [from, to, branchId],
  )
  return rows
}

export async function getFullBranchDashboard(tenantId, filters = {}) {
  const scope = scopeParams(filters, { defaultToday: true })
  const prev = previousRange(scope.from, scope.to)

  return withTenantClient(tenantId, async (client, tid) => {
    const q = (text, params) => clientQuery(client, text, params)

    const branchResult = scope.branchId
      ? await q(
          `SELECT name FROM branches WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
          [tid, scope.branchId],
        )
      : { rows: [] }
    const branchName = branchResult.rows[0]?.name || 'Branch'

    const totalsSql = `
      SELECT
        count(*)::int AS "saleCount",
        COALESCE(sum(final_amount), 0)::numeric AS "totalSales",
        COALESCE(sum(final_amount - return_amount), 0)::numeric AS "netSales"
      FROM sales
      WHERE tenant_id = $1
        AND status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR sold_at::date >= $2::date)
        AND ($3::date IS NULL OR sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR branch_id = $4)
    `

    const profitSql = `
      SELECT COALESCE(
        sum(si.line_total - (si.quantity * COALESCE(p.purchase_price, 0))),
        0
      )::numeric AS profit
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND si.is_exchange = false
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
    `

    const itemsSql = `
      SELECT COALESCE(sum(si.quantity), 0)::numeric AS "itemsSold"
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
    `

    const hourSql = `
      SELECT
        extract(hour FROM sold_at)::int AS hour,
        count(*)::int AS "saleCount",
        COALESCE(sum(final_amount), 0)::numeric AS revenue
      FROM sales
      WHERE tenant_id = $1
        AND status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR sold_at::date >= $2::date)
        AND ($3::date IS NULL OR sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR branch_id = $4)
      GROUP BY hour
      ORDER BY hour ASC
    `

    const topItemByHourSql = `
      SELECT DISTINCT ON (hour)
        hour,
        product_name AS "topItem"
      FROM (
        SELECT
          extract(hour FROM s.sold_at)::int AS hour,
          p.name AS product_name,
          sum(si.quantity) AS qty
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
        JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
        WHERE si.tenant_id = $1
          AND s.status IN ('completed', 'partial_refund')
          AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
          AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
          AND ($4::uuid IS NULL OR s.branch_id = $4)
        GROUP BY hour, p.id, p.name
      ) ranked
      ORDER BY hour ASC, qty DESC
    `

    const productsSql = `
      SELECT
        p.id,
        p.name,
        sum(si.quantity)::int AS units,
        sum(si.line_total)::numeric AS sales
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
      GROUP BY p.id, p.name
      ORDER BY units DESC, sales DESC
    `

    // Prefer POS till name/code; fall back to hardware name/code (never raw UUID)
    const countersSql = `
      SELECT
        COALESCE(
          c.id::text,
          'hw:' || COALESCE(NULLIF(TRIM(hw.code), ''), NULLIF(hw.id::text, ''), 'unassigned')
        ) AS "counterId",
        COALESCE(
          NULLIF(TRIM(c.code), ''),
          NULLIF(TRIM(hw.code), ''),
          'UNASSIGNED'
        ) AS "counterCode",
        COALESCE(
          NULLIF(TRIM(c.name), ''),
          NULLIF(TRIM(c.code), ''),
          NULLIF(TRIM(hw.name), ''),
          NULLIF(TRIM(hw.code), ''),
          'Unassigned till'
        ) AS "counterName",
        count(s.id)::int AS "saleCount",
        COALESCE(sum(s.final_amount), 0)::numeric AS revenue
      FROM sales s
      LEFT JOIN pos_counters c ON c.id = s.counter_id AND c.tenant_id = s.tenant_id
      LEFT JOIN staff st ON st.id = s.staff_id AND st.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = NULLIF(TRIM(st.hardware_device_id), '')
      WHERE s.tenant_id = $1
        AND s.status IN ('completed', 'partial_refund')
        AND ($2::date IS NULL OR s.sold_at::date >= $2::date)
        AND ($3::date IS NULL OR s.sold_at::date <= $3::date)
        AND ($4::uuid IS NULL OR s.branch_id = $4)
      GROUP BY c.id, c.code, c.name, hw.id, hw.code, hw.name
      ORDER BY revenue DESC
    `

    const staffSql = `
      SELECT
        s.id,
        u.full_name AS "name",
        s.image_url AS "image",
        s.status,
        d.name AS "role",
        ${WEIGHTED_RATING_SQL} AS "rating",
        COALESCE((
          SELECT SUM(lp.points)::numeric
          FROM (
            SELECT DISTINCT ON (ps.scale_id) ps.points
            FROM performance_scores ps
            INNER JOIN scoring_scales ss_live
              ON ss_live.id = ps.scale_id AND ss_live.tenant_id = ps.tenant_id
            WHERE ps.staff_id = s.id AND ps.tenant_id = s.tenant_id
            ORDER BY ps.scale_id, ps.scored_on DESC, ps.id DESC
          ) lp
        ), 0) AS "pointsRaw"
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2)
      ORDER BY "rating" DESC, u.full_name ASC
    `

    const inventorySql = `
      SELECT
        p.name,
        COALESCE(bi.quantity, 0)::int AS stock,
        GREATEST(
          COALESCE(bi.quantity, 0),
          COALESCE(p.reorder_point, 10) * 4,
          1
        )::int AS capacity,
        CASE
          WHEN COALESCE(bi.quantity, 0) <= 0 THEN 'critical'
          WHEN COALESCE(bi.quantity, 0) <= p.reorder_point THEN 'low'
          ELSE 'in_stock'
        END AS status
      FROM products p
      LEFT JOIN branch_inventory bi
        ON bi.tenant_id = p.tenant_id
        AND bi.product_id = p.id
        AND ($2::uuid IS NULL OR bi.branch_id = $2)
      WHERE p.tenant_id = $1
      ORDER BY stock ASC, p.name ASC
      LIMIT 10
    `

    const scopeParamsArr = [tid, scope.from, scope.to, scope.branchId]
    const prevParamsArr = [tid, prev.from, prev.to, scope.branchId]

    // Sequential on one connection — avoids Supabase session pool exhaustion
    const totalsRes = await q(totalsSql, scopeParamsArr)
    const prevTotalsRes = await q(totalsSql, prevParamsArr)
    const profitRes = await q(profitSql, scopeParamsArr)
    const prevProfitRes = await q(profitSql, prevParamsArr)
    const itemsRes = await q(itemsSql, scopeParamsArr)
    const hoursRes = await q(hourSql, scopeParamsArr)
    const topByHourRes = await q(topItemByHourSql, scopeParamsArr)
    const productsRes = await q(productsSql, scopeParamsArr)
    const prevProductsRes = await q(productsSql, prevParamsArr)
    const countersRes = await q(countersSql, scopeParamsArr)
    const staffRes = await q(staffSql, [tid, scope.branchId])
    const inventoryRes = await q(inventorySql, [tid, scope.branchId])

    const totals = totalsRes.rows[0] || {}
    const prevTotals = prevTotalsRes.rows[0] || {}
    const totalSales = Number(totals.totalSales) || 0
    const netSales = Number(totals.netSales) || 0
    const saleCount = Number(totals.saleCount) || 0
    const profit = Number(profitRes.rows[0]?.profit) || 0
    const prevProfit = Number(prevProfitRes.rows[0]?.profit) || 0
    const itemsSold = Number(itemsRes.rows[0]?.itemsSold) || 0

    const topItemByHour = new Map(
      (topByHourRes.rows || []).map((r) => [Number(r.hour), r.topItem]),
    )
    const hourMap = new Map(
      (hoursRes.rows || []).map((r) => [
        Number(r.hour),
        {
          saleCount: Number(r.saleCount) || 0,
          revenue: Number(r.revenue) || 0,
        },
      ]),
    )

    const salesByHour = Array.from({ length: 24 }, (_, hour) => {
      const row = hourMap.get(hour) || { saleCount: 0, revenue: 0 }
      return {
        hour: `${String(hour).padStart(2, '0')}:00`,
        sales: row.saleCount,
        revenue: row.revenue,
        topItem: topItemByHour.get(hour) || null,
      }
    })

    const peakRow = [...hourMap.entries()].sort(
      (a, b) => b[1].revenue - a[1].revenue || b[1].saleCount - a[1].saleCount,
    )[0]
    const peakHourNum = peakRow?.[0]
    const peakHour =
      peakHourNum == null
        ? '—'
        : `${String(peakHourNum).padStart(2, '0')}:00–${String(peakHourNum + 1).padStart(2, '0')}:00`
    const peakHourSales = peakRow ? peakRow[1].revenue : 0

    // Rank by units sold (quantity), not revenue — changePct also vs prior units
    const prevUnitsById = new Map(
      (prevProductsRes.rows || []).map((p) => [p.id, Number(p.units) || 0]),
    )
    const soldProducts = (productsRes.rows || [])
      .map((p) => {
        const units = Number(p.units) || 0
        const sales = Number(p.sales) || 0
        return {
          id: p.id,
          name: p.name,
          units,
          sales,
          changePct: pctChange(units, prevUnitsById.get(p.id) || 0),
        }
      })
      .sort((a, b) => b.units - a.units || b.sales - a.sales)

    // Top = highest units; Low = lowest units (exclude top so lists never overlap)
    const TOP_N = 3
    const LOW_N = 3
    const topProducts = soldProducts.slice(0, TOP_N)
    const topIds = new Set(topProducts.map((p) => p.id))
    const lowProducts = soldProducts
      .filter((p) => !topIds.has(p.id))
      .slice()
      .sort((a, b) => a.units - b.units || a.sales - b.sales)
      .slice(0, LOW_N)

    const staff = (staffRes.rows || []).map((row) => {
      const rating = Number(row.rating) || 0
      return {
        id: row.id,
        name: row.name,
        image: row.image,
        status: row.status,
        role: row.role,
        rating,
        points: rating,
        pointsRaw: Number(row.pointsRaw) || 0,
      }
    })

    return {
      branchName,
      date: scope.from || todayIso(),
      range: { from: scope.from, to: scope.to, branchId: scope.branchId },
      kpis: {
        totalSales,
        profit,
        saleCount,
        profitChangePct: pctChange(profit, prevProfit),
        salesChangePct: pctChange(totalSales, Number(prevTotals.totalSales) || 0),
        avgTicket: saleCount > 0 ? totalSales / saleCount : 0,
      },
      dailySummary: {
        revenue: totalSales,
        itemsSold,
        orders: saleCount,
        peakHour,
        peakHourSales,
      },
      salesByHour,
      // Mix Chart removed from UI — keep light payload for any legacy consumers
      productMix: soldProducts.map((p) => ({ name: p.name, units: p.units })),
      topProducts,
      lowProducts,
      counters: (countersRes.rows || []).map((c) => ({
        id: c.counterId,
        code: c.counterCode,
        name: c.counterName,
        sales: Number(c.revenue) || 0,
        orders: Number(c.saleCount) || 0,
      })),
      staff,
      inventory: inventoryRes.rows || [],
    }
  })
}

export async function buildBranchReport(tenantId, filters = {}) {
  const [overview, graph, staff, inventory] = await Promise.all([
    getBranchOverview(tenantId, filters),
    getSalesGraphData(tenantId, filters),
    listStaffPerformanceSnapshot(tenantId, { ...filters, page: 1, limit: 50 }),
    getInventoryStatusChart(tenantId, { ...filters, page: 1, limit: 50 }),
  ])

  return { overview, graph, staffPerformance: staff.items, inventoryStatus: inventory.items }
}

export function renderBranchReportHtml(report) {
  const { overview, graph, staffPerformance, inventoryStatus } = report
  const rangeLabel = `${overview.range.from || 'start'} → ${overview.range.to || 'now'}`
  const summary = overview.dailySalesSummary

  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  const rows = (items, cells) =>
    items
      .map((item) => `<tr>${cells(item).map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`)
      .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Branch Report</title>
  <style>
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; margin: 32px; }
    h1 { margin-bottom: 4px; }
    .meta { color: #555; margin-bottom: 24px; }
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 28px; }
    .kpi { border: 1px solid #ddd; padding: 12px; }
    .kpi strong { display: block; font-size: 1.4rem; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 28px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 14px; }
    th { background: #f5f5f5; }
    @media print { body { margin: 12mm; } .no-print { display: none; } }
  </style>
</head>
<body>
  <button class="no-print" onclick="window.print()">Print / Save PDF</button>
  <h1>Branch Overview Report</h1>
  <p class="meta">Range: ${escape(rangeLabel)}</p>

  <section class="kpis">
    <div class="kpi">Sale Count<strong>${escape(summary.saleCount)}</strong></div>
    <div class="kpi">Total Sales<strong>${escape(summary.totalSales)}</strong></div>
    <div class="kpi">Net Sales<strong>${escape(summary.netSales)}</strong></div>
    <div class="kpi">Items Sold<strong>${escape(summary.itemsSold)}</strong></div>
  </section>

  <h2>Highest / Lowest Products</h2>
  <table>
    <thead><tr><th>Type</th><th>Product</th><th>Qty</th><th>Revenue</th></tr></thead>
    <tbody>
      <tr>
        <td>Highest</td>
        <td>${escape(overview.highestSalesProduct?.productName || '—')}</td>
        <td>${escape(overview.highestSalesProduct?.quantity ?? '—')}</td>
        <td>${escape(overview.highestSalesProduct?.revenue ?? '—')}</td>
      </tr>
      <tr>
        <td>Lowest</td>
        <td>${escape(overview.lowestSalesProduct?.productName || '—')}</td>
        <td>${escape(overview.lowestSalesProduct?.quantity ?? '—')}</td>
        <td>${escape(overview.lowestSalesProduct?.revenue ?? '—')}</td>
      </tr>
    </tbody>
  </table>

  <h2>Per-Counter Sales</h2>
  <table>
    <thead><tr><th>Counter</th><th>Sales</th><th>Revenue</th></tr></thead>
    <tbody>
      ${
        rows(overview.perCounterSales, (c) => [c.counterName, c.saleCount, c.revenue]) ||
        '<tr><td colspan="3">No counter sales</td></tr>'
      }
    </tbody>
  </table>

  <h2>Sales by Hour</h2>
  <table>
    <thead><tr><th>Hour</th><th>Sales</th><th>Revenue</th></tr></thead>
    <tbody>
      ${
        rows(graph.salesByHour, (h) => [h.hour, h.saleCount, h.revenue]) ||
        '<tr><td colspan="3">No hourly sales</td></tr>'
      }
    </tbody>
  </table>

  <h2>Staff Performance</h2>
  <table>
    <thead><tr><th>Name</th><th>Status</th><th>Points</th></tr></thead>
    <tbody>
      ${
        rows(staffPerformance, (s) => [s.fullName, s.status, s.points]) ||
        '<tr><td colspan="3">No staff scores</td></tr>'
      }
    </tbody>
  </table>

  <h2>Inventory Status</h2>
  <table>
    <thead><tr><th>Item</th><th>Remaining</th><th>Status</th></tr></thead>
    <tbody>
      ${
        rows(inventoryStatus, (i) => [i.productName, i.remainingStock, i.status]) ||
        '<tr><td colspan="3">No inventory rows</td></tr>'
      }
    </tbody>
  </table>
</body>
</html>`
}
