import { tenantQuery } from '../../../config/db.js'

function mapPolicyRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    detail: row.detail || '',
    category: row.category || '',
    isActive: row.isActive !== false,
    // When true, POS prints this policy on the sale slip / invoice
    printOnSlip: Boolean(row.printOnSlip),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const POLICY_SELECT = `
  id,
  name,
  detail,
  category,
  is_active AS "isActive",
  print_on_slip AS "printOnSlip",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

export async function listPolicies(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 50))
  const offset = (page - 1) * limit
  const q = filters.q?.trim() || null
  const category =
    filters.category && filters.category !== 'all' ? filters.category.trim() : null

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM policies
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR category = $2)
        AND (
          $3::text IS NULL
          OR name ILIKE '%' || $3 || '%'
          OR detail ILIKE '%' || $3 || '%'
          OR COALESCE(category, '') ILIKE '%' || $3 || '%'
          OR id::text ILIKE '%' || $3 || '%'
        )
    `,
    [category, q],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${POLICY_SELECT}
      FROM policies
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR category = $2)
        AND (
          $3::text IS NULL
          OR name ILIKE '%' || $3 || '%'
          OR detail ILIKE '%' || $3 || '%'
          OR COALESCE(category, '') ILIKE '%' || $3 || '%'
          OR id::text ILIKE '%' || $3 || '%'
        )
      ORDER BY created_at DESC, name ASC
      LIMIT $4 OFFSET $5
    `,
    [category, q, limit, offset],
  )

  return {
    items: rows.map(mapPolicyRow),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}

export async function getPolicyById(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${POLICY_SELECT}
      FROM policies
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [id],
  )
  return mapPolicyRow(rows[0] || null)
}

// Active policies flagged for POS invoice / slip printing
export async function listSlipPolicies(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${POLICY_SELECT}
      FROM policies
      WHERE tenant_id = $1
        AND is_active = true
        AND print_on_slip = true
      ORDER BY name ASC
    `,
  )
  return rows.map(mapPolicyRow)
}

export async function createPolicy(tenantId, payload) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO policies (tenant_id, name, detail, category, is_active, print_on_slip)
      VALUES ($1, $2, $3, $4, COALESCE($5, true), COALESCE($6, false))
      RETURNING ${POLICY_SELECT}
    `,
    [
      payload.name.trim(),
      payload.detail.trim(),
      payload.category?.trim() || null,
      payload.isActive !== undefined ? payload.isActive : true,
      payload.printOnSlip !== undefined ? Boolean(payload.printOnSlip) : false,
    ],
  )
  return mapPolicyRow(rows[0] || null)
}

export async function updatePolicy(tenantId, id, payload) {
  const existing = await getPolicyById(tenantId, id)
  if (!existing) {
    const error = new Error('Policy not found')
    error.status = 404
    throw error
  }

  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE policies
      SET
        name = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE name END,
        detail = CASE WHEN $4::text IS NOT NULL THEN $4 ELSE detail END,
        category = CASE WHEN $5::boolean THEN $6 ELSE category END,
        is_active = CASE WHEN $7::boolean THEN $8 ELSE is_active END,
        print_on_slip = CASE WHEN $9::boolean THEN $10 ELSE print_on_slip END,
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING ${POLICY_SELECT}
    `,
    [
      id,
      payload.name !== undefined ? payload.name.trim() : null,
      payload.detail !== undefined ? payload.detail.trim() : null,
      payload.category !== undefined,
      payload.category !== undefined ? payload.category?.trim() || null : null,
      payload.isActive !== undefined,
      payload.isActive !== undefined ? Boolean(payload.isActive) : null,
      payload.printOnSlip !== undefined,
      payload.printOnSlip !== undefined ? Boolean(payload.printOnSlip) : null,
    ],
  )

  return mapPolicyRow(rows[0] || null)
}

export async function deletePolicy(tenantId, id) {
  const existing = await getPolicyById(tenantId, id)
  if (!existing) {
    const error = new Error('Policy not found')
    error.status = 404
    throw error
  }

  await tenantQuery(
    tenantId,
    `
      DELETE FROM policies
      WHERE tenant_id = $1 AND id = $2
    `,
    [id],
  )

  return { id, deleted: true }
}
