import { tenantQuery } from '../../../config/db.js'
import { normalizeSearchQuery } from '../../../utils/displayRef.util.js'

// UI shows SAL-{saleNumber} / TRK-{saleNumber}; DB stores raw sale_number (e.g. INV-1020)
function normalizeSaleSearchQuery(value) {
  const q = normalizeSearchQuery(value)
  if (!q) return null
  const stripped = q.replace(/^(sal|trk)[-_\s]*/i, '').trim()
  return stripped || q
}

export async function listSales(tenantId, filters = {}) {
  let query = `
    SELECT 
      s.id,
      s.sale_number AS "saleNumber",
      s.sold_at AS "soldAt",
      s.subtotal,
      s.tax_amount AS "taxAmount",
      s.discount_amount AS "discountAmount",
      s.final_amount AS "finalAmount",
      s.paid_amount AS "paidAmount",
      s.return_amount AS "returnAmount",
      s.status,
      COALESCE(s.currency, 'PKR') AS currency,
      COALESCE(
        json_agg(
          json_build_object(
            'id', si.id,
            'name', p.name,
            'quantity', si.quantity,
            'unitPrice', si.unit_price,
            'lineTotal', si.line_total,
            'isExchange', si.is_exchange
          )
        ) FILTER (WHERE si.id IS NOT NULL),
        '[]'
      ) AS "items"
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id AND si.tenant_id = s.tenant_id
    LEFT JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
    WHERE s.tenant_id = $1
  `
  const params = []
  if (filters.branchId) {
    params.push(filters.branchId)
    query += ` AND s.branch_id = $${params.length + 1}`
  }

  // Match raw sale_number, UUID, or UI-prefixed SAL-/TRK- queries
  const saleQ = normalizeSaleSearchQuery(filters.q)
  if (saleQ) {
    params.push(`%${saleQ}%`)
    const idx = params.length + 1
    query += ` AND (
      s.sale_number ILIKE $${idx}
      OR s.id::text ILIKE $${idx}
      OR ('SAL-' || COALESCE(s.sale_number, '')) ILIKE $${idx}
      OR ('TRK-' || COALESCE(s.sale_number, '')) ILIKE $${idx}
    )`
  }

  // Date range: from/to inclusive. Legacy `date` = single day (from=to).
  const rangeFrom = filters.from || filters.date || null
  const rangeTo = filters.to || filters.date || null
  if (rangeFrom) {
    params.push(rangeFrom)
    query += ` AND s.sold_at::date >= $${params.length + 1}::date`
  }
  if (rangeTo) {
    params.push(rangeTo)
    query += ` AND s.sold_at::date <= $${params.length + 1}::date`
  }

  // Catalog cascade: category → subcategory → product → variant (variant wins if set)
  if (filters.variantId) {
    params.push(filters.variantId)
    query += ` AND EXISTS (
      SELECT 1 FROM sale_items si_v
      WHERE si_v.sale_id = s.id
        AND si_v.tenant_id = s.tenant_id
        AND si_v.product_id = $${params.length + 1}
    )`
  } else if (filters.productId) {
    params.push(filters.productId)
    query += ` AND EXISTS (
      SELECT 1 FROM sale_items si_p
      JOIN products p_p ON p_p.id = si_p.product_id AND p_p.tenant_id = si_p.tenant_id
      WHERE si_p.sale_id = s.id
        AND si_p.tenant_id = s.tenant_id
        AND (
          si_p.product_id = $${params.length + 1}
          OR p_p.parent_id = $${params.length + 1}
        )
    )`
  } else if (filters.subcategoryId) {
    params.push(filters.subcategoryId)
    query += ` AND EXISTS (
      SELECT 1 FROM sale_items si_s
      JOIN products p_s ON p_s.id = si_s.product_id AND p_s.tenant_id = si_s.tenant_id
      WHERE si_s.sale_id = s.id
        AND si_s.tenant_id = s.tenant_id
        AND p_s.subcategory_id = $${params.length + 1}
    )`
  } else if (filters.categoryId || filters.category_id) {
    const catId = filters.categoryId || filters.category_id
    params.push(catId)
    query += ` AND EXISTS (
      SELECT 1 FROM sale_items si2
      JOIN products p2 ON p2.id = si2.product_id AND p2.tenant_id = si2.tenant_id
      WHERE si2.sale_id = s.id
        AND si2.tenant_id = s.tenant_id
        AND (
          p2.category_id = $${params.length + 1}
          OR p2.subcategory_id = $${params.length + 1}
        )
    )`
  }

  query += ` GROUP BY s.id ORDER BY s.sold_at DESC`

  const { rows } = await tenantQuery(tenantId, query, params)
  return rows
}

export async function refundSale(tenantId, saleId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE sales
      SET status = 'refunded', return_amount = final_amount
      WHERE tenant_id = $1 AND id = $2 AND status != 'refunded'
        AND ($3::uuid IS NULL OR branch_id = $3)
      RETURNING id, status, final_amount AS "refundedAmount"
    `,
    [saleId, branchId],
  )
  return rows[0]
}
