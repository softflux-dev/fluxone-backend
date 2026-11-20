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

// productId (variant parent) narrows to types / values its SKUs actually use.
export async function listAdminLogFilterVariantTypes(tenantId, { branchId, productId = null } = {}) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, name
      FROM variant_types vt
      WHERE vt.tenant_id = $1
        AND vt.branch_id = $2
        AND vt.is_active = true
        AND (
          $3::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM product_variant_options o
            JOIN products p ON p.id = o.product_id AND p.tenant_id = o.tenant_id
            WHERE o.tenant_id = vt.tenant_id
              AND o.variant_type_id = vt.id
              AND (p.parent_id = $3::uuid OR p.id = $3::uuid)
          )
        )
      ORDER BY name
      LIMIT 200
    `,
    [branchId, productId],
  )

  return rows
}

export async function listAdminLogFilterVariantValues(
  tenantId,
  { branchId, productId = null, variantTypeId = null } = {},
) {
  if (!branchId) return []

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT DISTINCT vv.id, vv.name
      FROM variant_values vv
      JOIN variant_types vt ON vt.id = vv.variant_type_id AND vt.tenant_id = vv.tenant_id
      WHERE vv.tenant_id = $1
        AND vt.branch_id = $2
        AND vv.is_active = true
        AND ($4::uuid IS NULL OR vv.variant_type_id = $4::uuid)
        AND (
          $3::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM product_variant_options o
            JOIN products p ON p.id = o.product_id AND p.tenant_id = o.tenant_id
            WHERE o.tenant_id = vv.tenant_id
              AND o.variant_value_id = vv.id
              AND (p.parent_id = $3::uuid OR p.id = $3::uuid)
          )
        )
      ORDER BY vv.name
      LIMIT 200
    `,
    [branchId, productId, variantTypeId],
  )

  return rows
}
