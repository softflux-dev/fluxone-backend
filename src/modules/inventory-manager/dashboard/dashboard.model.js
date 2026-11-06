import { tenantQuery } from '../../../config/db.js'

export async function getOverviewKpis(tenantId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        (
          SELECT count(*)::int
          FROM categories
          WHERE tenant_id = $1
            AND parent_id IS NULL
            AND is_active = true
            AND ($2::uuid IS NULL OR branch_id = $2)
        ) AS "totalCategories",
        (
          SELECT count(*)::int
          FROM categories c
          WHERE c.tenant_id = $1
            AND c.parent_id IS NOT NULL
            AND c.is_active = true
            AND ($2::uuid IS NULL OR c.branch_id = $2)
            AND EXISTS (
              SELECT 1
              FROM categories p
              WHERE p.tenant_id = c.tenant_id
                AND p.id = c.parent_id
                AND p.is_active = true
            )
        ) AS "totalSubCategories",
        (
          SELECT count(*)::int
          FROM products
          WHERE tenant_id = $1
            AND status = 'active'
            AND ($2::uuid IS NULL OR branch_id = $2)
        ) AS "totalItems"
    `,
    [branchId || null],
  )
  return rows[0]
}

// Open branch alerts & requests only — never dump the full product catalog
export async function listStockAlerts(tenantId, { page = 1, limit = 8, branchId = null } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        sr.id,
        p.name,
        sr.remaining_quantity AS "remainingNumber",
        CASE
          WHEN sr.remaining_quantity <= 0 THEN 'red'
          WHEN sr.remaining_quantity <= p.reorder_point THEN 'yellow'
          ELSE 'green'
        END AS status,
        CASE WHEN sr.kind = 'request' THEN 'branch_request' ELSE 'branch_alert' END AS source,
        count(*) OVER()::int AS "_total"
      FROM stock_requests sr
      JOIN products p ON p.id = sr.product_id AND p.tenant_id = sr.tenant_id
      WHERE sr.tenant_id = $1
        AND sr.status = 'open'
        AND ($2::uuid IS NULL OR p.branch_id = $2)
        AND ($2::uuid IS NULL OR sr.branch_id IS NULL OR sr.branch_id = $2)
      ORDER BY "remainingNumber" ASC
      LIMIT $3 OFFSET $4
    `,
    [branchId || null, safeLimit, offset],
  )

  const total = rows[0]?._total || 0
  const items = rows.map(({ _total, ...item }) => item)
  return { items, total, page: safePage, limit: safeLimit }
}

export async function listStockOutGraph(tenantId, { from, to, branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      WITH TopItems AS (
        SELECT
          l.product_id
        FROM inventory_ledger l
        JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
          AND l.movement_type IN ('out', 'damaged', 'expired')
          AND ($2::date IS NULL OR l.created_at::date >= $2::date)
          AND ($3::date IS NULL OR l.created_at::date <= $3::date)
          AND ($4::uuid IS NULL OR p.branch_id = $4)
        GROUP BY l.product_id
        ORDER BY sum(ABS(l.quantity)) DESC
        LIMIT 10
      )
      SELECT
        p.name,
        date_trunc('day', l.created_at)::date AS day,
        sum(ABS(l.quantity))::numeric AS quantity
      FROM inventory_ledger l
      JOIN TopItems ti ON ti.product_id = l.product_id
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.movement_type IN ('out', 'damaged', 'expired')
        AND ($2::date IS NULL OR l.created_at::date >= $2::date)
        AND ($3::date IS NULL OR l.created_at::date <= $3::date)
        AND ($4::uuid IS NULL OR p.branch_id = $4)
      GROUP BY p.name, day
      ORDER BY day ASC
    `,
    [from || null, to || null, branchId || null],
  )
  return rows
}
