import { tenantQuery } from '../../../config/db.js'
import { displayRefSearchHex, normalizeSearchQuery } from '../../../utils/displayRef.util.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'

const supplierSelect = `
  id,
  company_name AS "companyName",
  image_url AS "imageUrl",
  company_phone AS "companyPhone",
  representative_name AS "representativeName",
  representative_phone AS "representativePhone",
  representative_email AS "representativeEmail",
  location,
  tax_paid AS "taxPaid",
  registration_number AS "registrationNumber",
  bank_account_number AS "bankAccountNumber",
  signature_url AS "signatureUrl",
  is_active AS "isActive",
  branch_id AS "branchId"
`

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function mapPgUniqueViolation(err) {
  if (err?.code !== '23505') throw err
  const detail = String(err?.detail || err?.constraint || '')
  if (/reg/i.test(detail) || /registration/i.test(detail)) {
    throw httpError(
      409,
      'A supplier with the same registration number already exists in this branch.',
    )
  }
  if (/company/i.test(detail)) {
    throw httpError(409, 'A supplier with the same company name already exists in this branch.')
  }
  throw httpError(
    409,
    'A supplier with the same registration number or company name already exists.',
  )
}

function mapSupplierRow(row) {
  if (!row) return null
  return {
    ...row,
    imageUrl: normalizeImageUrl(row.imageUrl),
    signatureUrl: normalizeImageUrl(row.signatureUrl),
  }
}

function activeSqlClause(active) {
  if (active === 'all') return ''
  if (active === 'inactive') return 'AND is_active = false'
  return 'AND is_active = true'
}

// Branch scope
function branchClause(paramIndex) {
  return `AND ($${paramIndex}::uuid IS NULL OR branch_id = $${paramIndex})`
}

function normalizeUniqueText(value) {
  const text = String(value || '').trim()
  return text || null
}

/**
 * Block create/update when company name OR registration number already exists in-branch.
 * Example: "Asad"+123 fails if "Asad"+456 or "Ali"+123 already exists.
 */
async function assertUniqueSupplier(
  tenantId,
  { branchId, companyName, registrationNumber, excludeId = null },
) {
  if (!branchId) return

  const name = normalizeUniqueText(companyName)
  const reg = normalizeUniqueText(registrationNumber)

  if (name) {
    const { rows } = await tenantQuery(
      tenantId,
      `
        SELECT id, company_name AS "companyName"
        FROM suppliers
        WHERE tenant_id = $1
          AND branch_id = $2
          AND lower(btrim(company_name)) = lower(btrim($3::text))
          AND ($4::uuid IS NULL OR id <> $4)
        LIMIT 1
      `,
      [branchId, name, excludeId],
    )
    if (rows[0]) {
      throw httpError(
        409,
        `A supplier with the same company name ("${rows[0].companyName}") already exists in this branch.`,
      )
    }
  }

  if (reg) {
    const { rows } = await tenantQuery(
      tenantId,
      `
        SELECT id, registration_number AS "registrationNumber"
        FROM suppliers
        WHERE tenant_id = $1
          AND branch_id = $2
          AND registration_number IS NOT NULL
          AND btrim(registration_number) <> ''
          AND lower(btrim(registration_number)) = lower(btrim($3::text))
          AND ($4::uuid IS NULL OR id <> $4)
        LIMIT 1
      `,
      [branchId, reg, excludeId],
    )
    if (rows[0]) {
      throw httpError(
        409,
        `A supplier with the same registration number ("${rows[0].registrationNumber}") already exists in this branch.`,
      )
    }
  }
}

export async function listSuppliers(tenantId, { q, page = 1, limit = 8, active = 'active', branchId = null } = {}) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit
  const activeClause = activeSqlClause(active)

  // SUP-XXXXXXXX is UI-only — match via compact UUID hex (same pattern as staff/branches)
  const qNorm = normalizeSearchQuery(q) || null
  const qHex = qNorm ? displayRefSearchHex(qNorm, 'SUP') : null

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${supplierSelect},
        count(*) OVER()::int AS "_total"
      FROM suppliers
      WHERE tenant_id = $1
        ${activeClause}
        ${branchClause(2)}
        AND (
          $3::text IS NULL
          OR company_name ILIKE '%' || $3 || '%'
          OR id::text ILIKE '%' || $3 || '%'
          OR (
            $4::text IS NOT NULL
            AND REPLACE(LOWER(id::text), '-', '') ILIKE '%' || $4 || '%'
          )
        )
      ORDER BY company_name
      LIMIT $5 OFFSET $6
    `,
    [branchId, qNorm, qHex, safeLimit, offset],
  )

  const total = rows[0]?._total || 0
  const items = rows.map(({ _total, ...item }) => mapSupplierRow(item))
  return { items, total, page: safePage, limit: safeLimit }
}

export async function createSupplier(tenantId, payload) {
  if (!payload.branchId) {
    throw httpError(422, 'branchId is required to create a supplier')
  }

  await assertUniqueSupplier(tenantId, {
    branchId: payload.branchId,
    companyName: payload.companyName,
    registrationNumber: payload.registrationNumber,
  })

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        INSERT INTO suppliers (
          tenant_id, branch_id, company_name, image_url, company_phone, representative_name,
          representative_phone, representative_email, location, tax_paid,
          registration_number, bank_account_number, signature_url, is_active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
        RETURNING ${supplierSelect}
      `,
      [
        payload.branchId,
        payload.companyName,
        payload.imageUrl || null,
        payload.companyPhone || null,
        payload.representativeName || null,
        payload.representativePhone || null,
        payload.representativeEmail || null,
        payload.location || null,
        payload.taxPaid ?? false,
        payload.registrationNumber || null,
        payload.bankAccountNumber || null,
        payload.signatureUrl || null,
      ],
    )
    return mapSupplierRow(rows[0])
  } catch (err) {
    mapPgUniqueViolation(err)
  }
}

export async function updateSupplier(tenantId, id, payload, { branchId = null } = {}) {
  const updatableColumns = {
    companyName: 'company_name',
    companyPhone: 'company_phone',
    representativeName: 'representative_name',
    representativePhone: 'representative_phone',
    representativeEmail: 'representative_email',
    location: 'location',
    taxPaid: 'tax_paid',
    registrationNumber: 'registration_number',
    bankAccountNumber: 'bank_account_number',
    imageUrl: 'image_url',
    signatureUrl: 'signature_url',
    isActive: 'is_active',
  }

  const setClauses = []
  const params = [id, branchId]

  for (const [payloadKey, column] of Object.entries(updatableColumns)) {
    if (!(payloadKey in payload)) continue
    // Skip empty media URLs so a signature-only upload cannot clear company image (and vice versa)
    if (
      (payloadKey === 'imageUrl' || payloadKey === 'signatureUrl') &&
      (payload[payloadKey] == null || payload[payloadKey] === '')
    ) {
      continue
    }
    const paramIndex = params.length + 2
    setClauses.push(`${column} = $${paramIndex}`)
    params.push(payload[payloadKey] ?? null)
  }

  if (!setClauses.length) {
    const { rows } = await tenantQuery(
      tenantId,
      `
        SELECT ${supplierSelect}
        FROM suppliers
        WHERE tenant_id = $1 AND id = $2
          ${branchClause(3)}
        LIMIT 1
      `,
      [id, branchId],
    )
    return mapSupplierRow(rows[0] || null)
  }

  // Resolve branch + current name/reg when only one unique field is patched
  const { rows: existingRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        branch_id AS "branchId",
        company_name AS "companyName",
        registration_number AS "registrationNumber"
      FROM suppliers
      WHERE tenant_id = $1 AND id = $2
        ${branchClause(3)}
      LIMIT 1
    `,
    [id, branchId],
  )
  const existing = existingRows[0]
  if (!existing) return null

  const nextName =
    'companyName' in payload ? payload.companyName : existing.companyName
  const nextReg =
    'registrationNumber' in payload ? payload.registrationNumber : existing.registrationNumber

  await assertUniqueSupplier(tenantId, {
    branchId: existing.branchId || branchId,
    companyName: nextName,
    registrationNumber: nextReg,
    excludeId: id,
  })

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE suppliers
        SET ${setClauses.join(', ')}
        WHERE tenant_id = $1 AND id = $2
          ${branchClause(3)}
        RETURNING ${supplierSelect}
      `,
      params,
    )
    return mapSupplierRow(rows[0] || null)
  } catch (err) {
    mapPgUniqueViolation(err)
  }
}

export async function setSupplierActive(tenantId, id, isActive, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE suppliers
      SET is_active = $2
      WHERE tenant_id = $1 AND id = $3
        ${branchClause(4)}
      RETURNING ${supplierSelect}
    `,
    [isActive, id, branchId],
  )
  return mapSupplierRow(rows[0] || null)
}

// Hard delete — blocked when referenced by orders / ledger
export async function deleteSupplier(tenantId, id, { branchId = null } = {}) {
  const { rows: refs } = await tenantQuery(
    tenantId,
    `
      SELECT
        EXISTS (
          SELECT 1 FROM purchase_orders
          WHERE tenant_id = $1 AND supplier_id = $2
        ) AS "hasPoHeader",
        EXISTS (
          SELECT 1 FROM purchase_order_suppliers
          WHERE tenant_id = $1 AND supplier_id = $2
        ) AS "hasPoSupplier",
        EXISTS (
          SELECT 1 FROM purchase_order_items
          WHERE tenant_id = $1 AND supplier_id = $2
        ) AS "hasPoItems",
        EXISTS (
          SELECT 1 FROM inventory_ledger
          WHERE tenant_id = $1 AND supplier_id = $2
        ) AS "hasLedger"
    `,
    [id],
  )
  const hit = refs[0]
  if (hit?.hasPoHeader || hit?.hasPoSupplier || hit?.hasPoItems || hit?.hasLedger) {
    throw httpError(
      409,
      'Cannot delete supplier — it is referenced by existing order or stock records. Block the supplier instead.',
    )
  }
  const { rows } = await tenantQuery(
    tenantId,
    `
      DELETE FROM suppliers
      WHERE tenant_id = $1 AND id = $2
        ${branchClause(3)}
      RETURNING id, company_name AS "companyName", branch_id AS "branchId"
    `,
    [id, branchId],
  )
  return rows[0] || null
}

export async function assertSupplierActive(tenantId, id, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, is_active AS "isActive", company_name AS "companyName", branch_id AS "branchId"
      FROM suppliers
      WHERE tenant_id = $1 AND id = $2
        ${branchClause(3)}
      LIMIT 1
    `,
    [id, branchId],
  )
  const row = rows[0]
  if (!row) {
    throw httpError(404, 'Supplier not found')
  }
  if (!row.isActive) {
    throw httpError(409, 'Supplier is inactive and cannot be used for new orders')
  }
  return row
}
