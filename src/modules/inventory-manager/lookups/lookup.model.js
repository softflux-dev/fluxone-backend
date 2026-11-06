import { tenantQuery } from '../../../config/db.js'

export async function listEmployeesForLookup(
  tenantId,
  { q, page = 1, limit = 8, branchId = null } = {},
) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND u.is_active = true
        AND (
          $2::text IS NULL
          OR u.full_name ILIKE '%' || $2 || '%'
          OR u.email ILIKE '%' || $2 || '%'
          OR s.id::text ILIKE '%' || $2 || '%'
        )
        AND ($3::uuid IS NULL OR s.branch_id = $3)
    `,
    [q || null, branchId || null],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        u.id AS "userId",
        s.id AS "staffId",
        u.full_name AS "fullName",
        u.email,
        s.designation,
        s.branch_id AS "branchId"
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND u.is_active = true
        AND (
          $2::text IS NULL
          OR u.full_name ILIKE '%' || $2 || '%'
          OR u.email ILIKE '%' || $2 || '%'
          OR s.id::text ILIKE '%' || $2 || '%'
        )
        AND ($3::uuid IS NULL OR s.branch_id = $3)
      ORDER BY u.full_name
      LIMIT $4 OFFSET $5
    `,
    [q || null, branchId || null, safeLimit, offset],
  )
  return { items: rows, total: countRows[0]?.total || 0, page: safePage, limit: safeLimit }
}

export async function listBranchesForLookup(tenantId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, name, created_at AS "createdAt"
      FROM branches
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR id = $2)
      ORDER BY name
    `,
    [branchId || null],
  )
  return rows
}

export async function listBranchInventory(tenantId, { branchId, productId, page = 1, limit = 8 } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM branch_inventory bi
      WHERE bi.tenant_id = $1
        AND ($2::uuid IS NULL OR bi.branch_id = $2)
        AND ($3::uuid IS NULL OR bi.product_id = $3)
    `,
    [branchId || null, productId || null],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        bi.branch_id AS "branchId",
        b.name AS "branchName",
        bi.product_id AS "productId",
        p.name AS "productName",
        p.item_code AS "itemCode",
        p.scale,
        bi.quantity,
        bi.updated_at AS "updatedAt"
      FROM branch_inventory bi
      JOIN branches b ON b.id = bi.branch_id AND b.tenant_id = bi.tenant_id
      JOIN products p ON p.id = bi.product_id AND p.tenant_id = bi.tenant_id
      WHERE bi.tenant_id = $1
        AND ($2::uuid IS NULL OR bi.branch_id = $2)
        AND ($3::uuid IS NULL OR bi.product_id = $3)
      ORDER BY b.name, p.name
      LIMIT $4 OFFSET $5
    `,
    [branchId || null, productId || null, safeLimit, offset],
  )
  return { items: rows, total: countRows[0]?.total || 0, page: safePage, limit: safeLimit }
}
