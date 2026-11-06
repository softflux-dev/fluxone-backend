import { tenantQuery } from '../../../config/db.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

const scaleSelect = `
  id,
  code,
  name,
  created_at AS "createdAt"
`

function formatSeqCode(prefix, n) {
  return `${prefix}-${String(n).padStart(3, '0')}`
}

async function nextScaleCode(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT COALESCE(
        MAX(
          CASE
            WHEN code ~ '^ITM-[0-9]+$'
            THEN NULLIF(regexp_replace(code, '^ITM-', ''), '')::int
            ELSE 0
          END
        ),
        0
      ) + 1 AS next_n
      FROM item_scales
      WHERE tenant_id = $1
    `,
  )
  return formatSeqCode('ITM', rows[0]?.next_n || 1)
}

export async function listItemScales(tenantId, { q } = {}) {
  const search = q ? String(q).trim() : null
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${scaleSelect}
      FROM item_scales
      WHERE tenant_id = $1
        AND (
          $2::text IS NULL
          OR name ILIKE '%' || $2 || '%'
          OR code ILIKE '%' || $2 || '%'
        )
      ORDER BY
        CASE
          WHEN code ~ '^ITM-[0-9]+$'
          THEN NULLIF(regexp_replace(code, '^ITM-', ''), '')::int
          ELSE 999999
        END ASC,
        created_at ASC,
        name ASC
    `,
    [search],
  )
  return rows
}

export async function getItemScaleById(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${scaleSelect}
      FROM item_scales
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [id],
  )
  return rows[0] || null
}

export async function createItemScale(tenantId, { name }) {
  const scaleName = String(name || '').trim()
  if (!scaleName) throw httpError(400, 'Scale name is required')

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = await nextScaleCode(tenantId)
    try {
      const { rows } = await tenantQuery(
        tenantId,
        `
          INSERT INTO item_scales (tenant_id, name, code)
          VALUES ($1, $2, $3)
          RETURNING ${scaleSelect}
        `,
        [scaleName, code],
      )
      return rows[0]
    } catch (err) {
      if (err?.code === '23505' && attempt < 5) {
        // Unique name or code collision — retry only for code collisions.
        if (String(err?.detail || '').includes('(name)')) {
          throw httpError(409, 'Scale name already exists')
        }
        continue
      }
      if (err?.code === '23505') {
        throw httpError(409, 'Scale name already exists')
      }
      throw err
    }
  }

  throw httpError(500, 'Failed to allocate a unique scale ID')
}

export async function updateItemScale(tenantId, id, { name }) {
  const scaleName = String(name || '').trim()
  if (!scaleName) throw httpError(400, 'Scale name is required')

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE item_scales
        SET name = $2
        WHERE tenant_id = $1 AND id = $3
        RETURNING ${scaleSelect}
      `,
      [scaleName, id],
    )
    return rows[0] || null
  } catch (err) {
    if (err?.code === '23505') {
      throw httpError(409, 'Scale name already exists')
    }
    throw err
  }
}

export async function deleteItemScale(tenantId, id) {
  const existing = await getItemScaleById(tenantId, id)
  if (!existing) return null

  const { rows: used } = await tenantQuery(
    tenantId,
    `
      SELECT id
      FROM products
      WHERE tenant_id = $1 AND lower(scale) = lower($2)
      LIMIT 1
    `,
    [existing.name],
  )
  if (used.length > 0) {
    throw httpError(409, 'Cannot delete scale. It is currently used by one or more products.')
  }

  const { rowCount } = await tenantQuery(
    tenantId,
    `DELETE FROM item_scales WHERE tenant_id = $1 AND id = $2`,
    [id],
  )
  return rowCount > 0 ? existing : null
}
