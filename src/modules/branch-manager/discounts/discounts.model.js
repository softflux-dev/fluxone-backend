import { tenantQuery } from '../../../config/db.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function mapOffer(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    percent: Number(row.percent),
    categoryId: row.categoryId || null,
    categoryName: row.categoryName || null,
    branchId: row.branchId || null,
  }
}

export async function assertCategoryInBranch(tenantId, categoryId, branchId) {
  if (!categoryId || !branchId) return
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM categories
      WHERE tenant_id = $1 AND id = $2 AND branch_id = $3 AND is_active = true
      LIMIT 1
    `,
    [categoryId, branchId],
  )
  if (!rows[0]) {
    throw httpError(422, 'Category not found for this branch')
  }
}

export async function createOffer(tenantId, { name, percent, categoryId, branchId }) {
  // Offers are branch-owned — never create unscoped rows
  if (!branchId) throw httpError(400, 'branchId is required for discount offers')

  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO offers (tenant_id, branch_id, name, percent, category_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [branchId, name.trim(), parseFloat(percent), categoryId || null],
  )
  return getOfferById(tenantId, rows[0].id, { branchId })
}

export async function listOffers(tenantId, { branchId = null, categoryId, q } = {}) {
  const search = String(q || '').trim() || null

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        o.id,
        o.name,
        o.percent,
        o.category_id AS "categoryId",
        o.branch_id AS "branchId",
        c.name AS "categoryName"
      FROM offers o
      LEFT JOIN categories c
        ON c.id = o.category_id
       AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1
        -- Branch isolation: BM always passes branchId; null orphans stay hidden
        AND (
          ($2::uuid IS NULL AND o.branch_id IS NOT NULL)
          OR o.branch_id = $2
        )
        AND ($3::uuid IS NULL OR o.category_id = $3)
        AND (
          $4::text IS NULL
          OR o.name ILIKE '%' || $4 || '%'
          OR REPLACE(o.id::text, '-', '') ILIKE '%' || REPLACE($4, '-', '') || '%'
        )
      ORDER BY o.name ASC
    `,
    [branchId, categoryId || null, search],
  )
  return rows.map(mapOffer)
}

export async function getOfferById(tenantId, id, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        o.id,
        o.name,
        o.percent,
        o.category_id AS "categoryId",
        o.branch_id AS "branchId",
        c.name AS "categoryName"
      FROM offers o
      LEFT JOIN categories c
        ON c.id = o.category_id
       AND c.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1
        AND o.id = $2
        AND ($3::uuid IS NULL OR o.branch_id = $3)
      LIMIT 1
    `,
    [id, branchId],
  )
  return mapOffer(rows[0])
}

export async function updateOffer(tenantId, id, { name, percent, categoryId }, { branchId = null } = {}) {
  const existing = await getOfferById(tenantId, id, { branchId })
  if (!existing) return null

  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE offers
      SET name = $2,
          percent = $3,
          category_id = $4
      WHERE tenant_id = $1
        AND id = $5
        AND ($6::uuid IS NULL OR branch_id = $6)
      RETURNING id
    `,
    [name.trim(), parseFloat(percent), categoryId || null, id, branchId],
  )
  if (!rows[0]) return null
  return getOfferById(tenantId, id, { branchId })
}

export async function deleteOffer(tenantId, id, { branchId = null } = {}) {
  const existing = await getOfferById(tenantId, id, { branchId })
  if (!existing) return false

  // Block delete while products in this branch still reference the offer
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM products
      WHERE tenant_id = $1
        AND offer_id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [id, branchId],
  )
  if (rows.length > 0) {
    throw httpError(
      409,
      'This discount is currently assigned to one or more active products and cannot be deleted.',
    )
  }

  const { rowCount } = await tenantQuery(
    tenantId,
    `
      DELETE FROM offers
      WHERE tenant_id = $1
        AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
    `,
    [id, branchId],
  )
  return rowCount > 0
}
