import { tenantQuery } from '../../../config/db.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function mapPgUniqueViolation(err, message) {
  if (err?.code === '23505') {
    throw httpError(409, message)
  }
  throw err
}

const designationSelect = `
  id,
  name,
  is_active AS "isActive",
  created_at AS "createdAt"
`

function activeSqlClause(active) {
  if (active === 'all') return ''
  if (active === 'inactive') return 'AND is_active = false'
  return 'AND is_active = true'
}

export async function listDesignations(tenantId, { q, page = 1, limit = 8, active = 'active' } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit
  const activeClause = activeSqlClause(active)

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM designations
      WHERE tenant_id = $1
        ${activeClause}
        AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
    `,
    [q || null],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${designationSelect}
      FROM designations
      WHERE tenant_id = $1
        ${activeClause}
        AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
      ORDER BY name ASC
      LIMIT $3 OFFSET $4
    `,
    [q || null, safeLimit, offset],
  )

  return { items: rows, total: countRows[0]?.total || 0, page: safePage, limit: safeLimit }
}

export async function getDesignationById(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${designationSelect}
      FROM designations
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [id],
  )
  return rows[0] || null
}

export async function createDesignation(tenantId, { name }) {
  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        INSERT INTO designations (tenant_id, name, is_active)
        VALUES ($1, $2, true)
        RETURNING ${designationSelect}
      `,
      [name.trim()],
    )
    return rows[0]
  } catch (err) {
    mapPgUniqueViolation(err, 'Designation name already exists')
  }
}

export async function updateDesignation(tenantId, id, { name, isActive }) {
  try {
    const setClauses = []
    const params = [id]

    if (name !== undefined) {
      setClauses.push(`name = $${params.length + 2}`)
      params.push(name.trim())
    }
    if (isActive !== undefined) {
      setClauses.push(`is_active = $${params.length + 2}`)
      params.push(isActive)
    }

    if (!setClauses.length) {
      return getDesignationById(tenantId, id)
    }

    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE designations
        SET ${setClauses.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${designationSelect}
      `,
      params,
    )
    return rows[0] || null
  } catch (err) {
    mapPgUniqueViolation(err, 'Designation name already exists')
  }
}

export async function setDesignationActive(tenantId, id, isActive) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE designations
      SET is_active = $2
      WHERE tenant_id = $1 AND id = $3
      RETURNING ${designationSelect}
    `,
    [isActive, id],
  )
  return rows[0] || null
}

// Soft-deactivate. Keeps staff.designation_id for history.
export async function deleteDesignation(tenantId, id) {
  return setDesignationActive(tenantId, id, false)
}
