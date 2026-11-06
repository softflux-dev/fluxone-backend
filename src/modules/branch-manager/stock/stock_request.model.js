import { tenantQuery } from '../../../config/db.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

export async function listStockRequests(tenantId, { status, branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        sr.id,
        sr.kind,
        sr.status,
        sr.remaining_quantity AS "remainingQuantity",
        sr.created_at AS "createdAt",
        p.id AS "productId",
        p.name AS "productName",
        p.item_code AS "itemCode",
        sr.branch_id AS "branchId"
      FROM stock_requests sr
      JOIN products p ON p.id = sr.product_id AND p.tenant_id = sr.tenant_id
      WHERE sr.tenant_id = $1
        AND ($2::text IS NULL OR sr.status = $2)
        AND ($3::uuid IS NULL OR sr.branch_id = $3)
      ORDER BY sr.created_at DESC
    `,
    [status || null, branchId],
  )
  return rows
}

export async function createStockRequest(tenantId, payload) {
  const branchId = payload.branchId || null
  const { rows: products } = await tenantQuery(
    tenantId,
    `
      SELECT id, name, quantity, item_code AS "itemCode", branch_id AS "branchId"
      FROM products
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [payload.productId, branchId],
  )
  if (!products[0]) throw httpError(404, 'Product not found')

  const requiredQty = Math.floor(Number(payload.remainingQuantity))
  if (!Number.isFinite(requiredQty) || requiredQty < 1) {
    throw httpError(400, 'Required quantity must be a whole number of at least 1')
  }

  let branchName = null
  if (branchId) {
    const { rows: branches } = await tenantQuery(
      tenantId,
      `SELECT name FROM branches WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
      [branchId],
    )
    branchName = branches[0]?.name || null
  }

  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO stock_requests (
        tenant_id, branch_id, product_id, remaining_quantity, kind, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, 'open', $6)
      RETURNING
        id,
        kind,
        status,
        remaining_quantity AS "remainingQuantity",
        branch_id AS "branchId",
        product_id AS "productId",
        created_by AS "createdBy",
        created_at AS "createdAt"
    `,
    [
      branchId,
      payload.productId,
      requiredQty,
      payload.kind,
      payload.createdBy || null,
    ],
  )

  const row = rows[0]
  return {
    ...row,
    productName: products[0].name,
    itemCode: products[0].itemCode,
    branchName,
  }
}
