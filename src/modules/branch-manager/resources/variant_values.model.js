import { tenantQuery } from '../../../config/db.js'
import { getVariantTypeById } from './variant_types.model.js'

function httpError(status, message, extra = {}) {
  const error = new Error(message)
  error.status = status
  Object.assign(error, extra)
  return error
}

function mapPgUniqueViolation(err, message) {
  if (err?.code === '23505') {
    throw httpError(409, message)
  }
  throw err
}

const valueSelect = `
  vv.id,
  vv.variant_type_id AS "variantTypeId",
  vt.name AS "variantTypeName",
  vv.name,
  vv.is_active AS "isActive",
  vv.branch_id AS "branchId",
  vv.created_at AS "createdAt",
  vv.updated_at AS "updatedAt"
`

function activeSqlClause(active, column = 'vv.is_active') {
  if (active === 'all') return ''
  if (active === 'inactive') return `AND ${column} = false`
  return `AND ${column} = true`
}

function normalizeName(name) {
  return String(name || '').trim()
}

export async function listVariantValues(
  tenantId,
  { q, variantTypeId, active = 'all', branchId = null } = {},
) {
  const search = q ? String(q).trim() : null
  const typeId = variantTypeId || null
  const activeClause = activeSqlClause(active)

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${valueSelect}
      FROM variant_values vv
      INNER JOIN variant_types vt
        ON vt.id = vv.variant_type_id
       AND vt.tenant_id = vv.tenant_id
      WHERE vv.tenant_id = $1
        ${activeClause}
        AND ($2::uuid IS NULL OR vv.branch_id = $2)
        AND ($3::uuid IS NULL OR vv.variant_type_id = $3)
        AND (
          $4::text IS NULL
          OR vv.name ILIKE '%' || $4 || '%'
          OR vt.name ILIKE '%' || $4 || '%'
        )
      ORDER BY vt.name ASC, vv.name ASC
    `,
    [branchId, typeId, search],
  )
  return rows
}

export async function getVariantValueById(tenantId, id, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${valueSelect}
      FROM variant_values vv
      INNER JOIN variant_types vt
        ON vt.id = vv.variant_type_id
       AND vt.tenant_id = vv.tenant_id
      WHERE vv.tenant_id = $1 AND vv.id = $2
        AND ($3::uuid IS NULL OR vv.branch_id = $3)
      LIMIT 1
    `,
    [id, branchId],
  )
  return rows[0] || null
}

async function assertTypeInBranch(
  tenantId,
  variantTypeId,
  branchId,
  { requireActive = false } = {},
) {
  const type = await getVariantTypeById(tenantId, variantTypeId, { branchId })
  if (!type) {
    throw httpError(404, 'Variant type not found')
  }
  if (requireActive && type.isActive === false) {
    throw httpError(400, 'Cannot assign values to an inactive variant type')
  }
  return type
}

export async function createVariantValue(
  tenantId,
  { variantTypeId, name, isActive = true, branchId },
) {
  const valueName = normalizeName(name)
  if (!valueName) throw httpError(400, 'Variant value name is required')
  if (!variantTypeId) throw httpError(400, 'Variant type is required')
  if (!branchId) throw httpError(400, 'branchId is required')

  const type = await assertTypeInBranch(tenantId, variantTypeId, branchId, {
    requireActive: true,
  })

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        INSERT INTO variant_values (tenant_id, branch_id, variant_type_id, name, is_active)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [branchId, type.id, valueName, Boolean(isActive)],
    )
    return getVariantValueById(tenantId, rows[0].id, { branchId })
  } catch (err) {
    mapPgUniqueViolation(err, 'Variant value name already exists under this type')
  }
}

export async function updateVariantValue(
  tenantId,
  id,
  { variantTypeId, name, isActive },
  { branchId = null } = {},
) {
  const existing = await getVariantValueById(tenantId, id, { branchId })
  if (!existing) return null

  const setClauses = ['updated_at = now()']
  const params = [id]

  if (variantTypeId !== undefined) {
    const type = await assertTypeInBranch(
      tenantId,
      variantTypeId,
      branchId || existing.branchId,
      { requireActive: true },
    )
    params.push(type.id)
    setClauses.push(`variant_type_id = $${params.length + 1}`)
  }

  if (name !== undefined) {
    const valueName = normalizeName(name)
    if (!valueName) throw httpError(400, 'Variant value name is required')
    params.push(valueName)
    setClauses.push(`name = $${params.length + 1}`)
  }

  if (isActive !== undefined) {
    params.push(Boolean(isActive))
    setClauses.push(`is_active = $${params.length + 1}`)
  }

  params.push(branchId)
  const branchParam = params.length + 1

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE variant_values
        SET ${setClauses.join(', ')}
        WHERE tenant_id = $1 AND id = $2
          AND ($${branchParam}::uuid IS NULL OR branch_id = $${branchParam})
        RETURNING id
      `,
      params,
    )
    if (!rows[0]) return null
    return getVariantValueById(tenantId, id, { branchId })
  } catch (err) {
    mapPgUniqueViolation(err, 'Variant value name already exists under this type')
  }
}

export async function deleteVariantValue(tenantId, id, { branchId = null } = {}) {
  const existing = await getVariantValueById(tenantId, id, { branchId })
  if (!existing) return null

  const { rowCount } = await tenantQuery(
    tenantId,
    `
      DELETE FROM variant_values
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
    `,
    [id, branchId],
  )

  if (rowCount === 0) return null

  return {
    id: existing.id,
    name: existing.name,
    variantTypeId: existing.variantTypeId,
    variantTypeName: existing.variantTypeName,
  }
}
