import { tenantQuery } from '../../../config/db.js'
import { PRODUCT_TYPES } from '../../../config/constants.js'

/** Progressive employee filter — branch required; role optional. */
export async function listAdminLogActors(tenantId, { branchId, actorRole = null } = {}) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT DISTINCT
        u.id AS "userId",
        u.full_name AS "fullName",
        r.slug AS role
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      WHERE s.tenant_id = $1
        AND s.branch_id = $2
        AND ($3::text IS NULL OR r.slug = $3)
        AND s.status NOT IN ('inactive', 'blocked')
        AND u.is_active = true
      ORDER BY u.full_name
      LIMIT 500
    `,
    [branchId, actorRole || null],
  )

  return rows
}

export async function listAdminLogFilterProducts(
  tenantId,
  { branchId, productType = null } = {},
) {
  if (!branchId) return []

  const typeFilter =
    productType === 'variant'
      ? PRODUCT_TYPES.VARIANT
      : productType === 'normal'
        ? PRODUCT_TYPES.SINGLE
        : null

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, name, type
      FROM products
      WHERE tenant_id = $1
        AND branch_id = $2
        AND type IN ('single', 'variant')
        AND status = 'active'
        AND ($3::text IS NULL OR type = $3)
      ORDER BY name
      LIMIT 500
    `,
    [branchId, typeFilter],
  )

  return rows
}

export async function listAdminLogFilterBundles(tenantId, { branchId } = {}) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, name
      FROM products
      WHERE tenant_id = $1
        AND branch_id = $2
        AND type = $3
        AND status = 'active'
      ORDER BY name
      LIMIT 500
    `,
    [branchId, PRODUCT_TYPES.BUNDLE],
  )

  return rows
}

export async function listAdminLogFilterSuppliers(tenantId, { branchId } = {}) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, company_name AS "companyName"
      FROM suppliers
      WHERE tenant_id = $1
        AND branch_id = $2
        AND is_active = true
      ORDER BY company_name
      LIMIT 500
    `,
    [branchId],
  )

  return rows
}

export async function listAdminLogFilterVariantTypes(tenantId, { branchId } = {}) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, name
      FROM variant_types
      WHERE tenant_id = $1
        AND branch_id = $2
        AND is_active = true
      ORDER BY name
      LIMIT 200
    `,
    [branchId],
  )

  return rows
}
