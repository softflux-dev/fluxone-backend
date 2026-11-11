import crypto from 'crypto'
import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import { MOVEMENT_TYPES, PRODUCT_STATUS, PRODUCT_TYPES } from '../../../config/constants.js'
import { generateBarcodeValue, generateItemCode } from '../../../utils/barcode.util.js'
import { sellingFromPurchase } from '../../../utils/pricing.util.js'
import { findOrCreateTaxByRate } from '../../../utils/tax.util.js'
import {
  assertPriceChangeAllowed,
  insertLedgerEventInTx,
} from '../control/control.model.js'
import { notifyBranchManagersOfCustomVariants } from '../../notifications/notifications.service.js'
import {
  applyBundleAssembleDelta,
  loadBundleRecipe,
} from './bundleAssemble.js'
import {
  assertSellingGtePurchase,
  branchClause,
  httpError,
  isLooseUuid,
  mapCategoryRow,
  mapUniqueViolation,
  resolveVariantPromo,
} from './product.shared.js'
import { getProductDeleteEligibility } from './product.read.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'
import {
  formatMoneyLabel,
  getTenantCurrencyCode,
} from '../../../utils/currency.util.js'



async function getOfferLabel(client, offerId) {
  if (!offerId) return "";
  try {
    const { rows } = await client.query(
      `SELECT name, percent FROM offers WHERE id = $1`,
      [offerId]
    );
    if (!rows[0]) return "";
    return ` "${rows[0].name}" (${Number(rows[0].percent)}%)`;
  } catch (err) {
    console.error("getOfferLabel failed:", err.message);
    return "";
  }
}

/** Admin Logs — products / bundles / pricing / variants from product writes. */
async function logProductActivity(client, tenantId, payload) {
  await writeAdminActivity(tenantId, payload, client)
}

const CATEGORY_NAME_MAX = 50
const SUBCATEGORY_NAME_MAX = 60

function assertCategoryNameLength(name, isSubcategory) {
  const max = isSubcategory ? SUBCATEGORY_NAME_MAX : CATEGORY_NAME_MAX
  const trimmed = String(name || '').trim()
  if (trimmed.length > max) {
    throw httpError(400, `Name must be at most ${max} characters`)
  }
}

export async function createCategory(tenantId, { name, parentId, imageUrl, branchId }) {
  if (!branchId) throw httpError(422, 'branchId is required to create a category')
  assertCategoryNameLength(name, Boolean(parentId))

  if (parentId) {
    const { rows: parents } = await tenantQuery(
      tenantId,
      `
        SELECT id, is_active AS "isActive"
        FROM categories
        WHERE tenant_id = $1 AND id = $2 AND parent_id IS NULL
          AND branch_id = $3
        LIMIT 1
      `,
      [parentId, branchId],
    )
    if (!parents[0]) throw httpError(404, 'Parent category not found')
    if (!parents[0].isActive) throw httpError(409, 'Cannot add subcategory under an inactive category')
  }


  // Soft-deleted row with same name — reactivate instead of INSERT (unique index includes inactive)
  const { rows: existing } = await tenantQuery(
    tenantId,
    `
      SELECT id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
        branch_id AS "branchId"
      FROM categories
      WHERE tenant_id = $1
        AND branch_id = $2
        AND name = $3
        AND (
          ($4::uuid IS NULL AND parent_id IS NULL)
          OR parent_id = $4
        )
      LIMIT 1
    `,
    [branchId, name, parentId || null],
  )

  if (existing[0]) {
    if (existing[0].isActive) {
      throw httpError(409, 'A category with this name already exists')
    }
    const params = [existing[0].id]
    const imageSet = imageUrl ? `, image_url = $3` : ''
    if (imageUrl) params.push(imageUrl)
    const { rows } = await tenantQuery(
      tenantId,
      `
        UPDATE categories
        SET is_active = true${imageSet}
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
          branch_id AS "branchId"
      `,
      params,
    )
    return mapCategoryRow(rows[0])
  }

  try {
    const { rows } = await tenantQuery(
      tenantId,
      `
        INSERT INTO categories (tenant_id, branch_id, parent_id, name, image_url, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        RETURNING id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
          branch_id AS "branchId"
      `,
      [branchId, parentId || null, name, imageUrl || null],
    )
    return mapCategoryRow(rows[0])
  } catch (err) {
    mapUniqueViolation(err, 'A category with this name already exists')
  }
}

export async function updateCategory(tenantId, id, { name, imageUrl, isActive, branchId = null }) {
  if (isActive !== undefined) {
    return setCategoryActive(tenantId, id, isActive, { branchId })
  }

  // Apply 50 / 60 cap from existing parent_id
  if (name !== undefined) {
    const { rows: existingRows } = await tenantQuery(
      tenantId,
      `
        SELECT parent_id AS "parentId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        LIMIT 1
      `,
      [id, branchId],
    )
    if (!existingRows[0]) return null
    assertCategoryNameLength(name, Boolean(existingRows[0].parentId))
  }

  const setClauses = []
  const params = [id, branchId]

  if (name !== undefined) {
    setClauses.push(`name = $${params.length + 2}`)
    params.push(name)
  }
  if (imageUrl !== undefined) {
    setClauses.push(`image_url = $${params.length + 2}`)
    params.push(imageUrl)
  }

  if (!setClauses.length) {
    const { rows } = await tenantQuery(
      tenantId,
      `
        SELECT id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
          branch_id AS "branchId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        LIMIT 1
      `,
      [id, branchId],
    )
    return mapCategoryRow(rows[0] || null)
  }

  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE categories
      SET ${setClauses.join(', ')}
      WHERE tenant_id = $1 AND id = $2
        ${branchClause('', 3)}
      RETURNING id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
        branch_id AS "branchId"
    `,
    params,
  )
  return mapCategoryRow(rows[0] || null)
}

// Soft-disable category.
// - Parent inactive → cascade inactive children; clear product category_id + subcategory_id
// - Subcategory inactive → clear product subcategory_id only
// Products stay active; category shows as N/A.
export async function setCategoryActive(tenantId, id, isActive, { branchId = null } = {}) {
  return withTransaction(async (client) => {
    const { rows: existing } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, parent_id AS "parentId", is_active AS "isActive", branch_id AS "branchId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        LIMIT 1
      `,
      [id, branchId],
    )
    const row = existing[0]
    if (!row) return null

    if (isActive) {
      if (row.parentId) {
        const { rows: parents } = await tenantClientQuery(
          client,
          tenantId,
          `
            SELECT is_active AS "isActive"
            FROM categories
            WHERE tenant_id = $1 AND id = $2
            LIMIT 1
          `,
          [row.parentId],
        )
        if (parents[0] && !parents[0].isActive) {
          throw httpError(409, 'Activate the parent category first')
        }
      }
      await tenantClientQuery(
        client,
        tenantId,
        `UPDATE categories SET is_active = true WHERE tenant_id = $1 AND id = $2`,
        [id],
      )
    } else {
      const isParent = !row.parentId
      if (isParent) {
        await tenantClientQuery(
          client,
          tenantId,
          `UPDATE categories SET is_active = false WHERE tenant_id = $1 AND (id = $2 OR parent_id = $2)`,
          [id],
        )
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE products
            SET category_id = NULL, subcategory_id = NULL
            WHERE tenant_id = $1 AND category_id = $2
          `,
          [id],
        )
      } else {
        await tenantClientQuery(
          client,
          tenantId,
          `UPDATE categories SET is_active = false WHERE tenant_id = $1 AND id = $2`,
          [id],
        )
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE products
            SET subcategory_id = NULL
            WHERE tenant_id = $1 AND subcategory_id = $2
          `,
          [id],
        )
      }
    }

    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, parent_id AS "parentId", name, image_url AS "imageUrl", is_active AS "isActive",
          branch_id AS "branchId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
      `,
      [id],
    )
    return rows[0] || null
  })
}

// Product / child counts for delete vs deactivate decisions (QA TC-Categree deletion-087).
export async function getCategoryDependencies(tenantId, id, { branchId = null } = {}) {
  const { rows: existing } = await tenantQuery(
    tenantId,
    `
      SELECT id, parent_id AS "parentId", name
      FROM categories
      WHERE tenant_id = $1 AND id = $2
        ${branchClause('', 3)}
      LIMIT 1
    `,
    [id, branchId],
  )
  const row = existing[0]
  if (!row) return null

  const isParent = !row.parentId

  if (isParent) {
    const { rows: subRows } = await tenantQuery(
      tenantId,
      `
        SELECT COUNT(*)::int AS total
        FROM categories
        WHERE tenant_id = $1 AND parent_id = $2
      `,
      [id],
    )
    const { rows: productRows } = await tenantQuery(
      tenantId,
      `
        SELECT COUNT(*)::int AS total
        FROM products
        WHERE tenant_id = $1
          AND (category_id = $2 OR subcategory_id IN (
            SELECT id FROM categories WHERE tenant_id = $1 AND parent_id = $2
          ))
      `,
      [id],
    )
    return {
      id: row.id,
      name: row.name,
      parentId: null,
      subcategoryCount: subRows[0]?.total || 0,
      productCount: productRows[0]?.total || 0,
    }
  }

  const { rows: productRows } = await tenantQuery(
    tenantId,
    `
      SELECT COUNT(*)::int AS total
      FROM products
      WHERE tenant_id = $1 AND subcategory_id = $2
    `,
    [id],
  )
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    subcategoryCount: 0,
    productCount: productRows[0]?.total || 0,
  }
}

// Hard delete only when unused. Prefer setCategoryActive when products are assigned.
export async function deleteCategory(tenantId, id, { branchId = null } = {}) {
  const deps = await getCategoryDependencies(tenantId, id, { branchId })
  if (!deps) throw httpError(404, 'Category not found')

  if (deps.productCount > 0) {
    const label = deps.parentId ? 'subcategory' : 'category'
    throw httpError(
      409,
      `Cannot delete this ${label}: ${deps.productCount} product(s) assigned` +
      (deps.subcategoryCount > 0 ? ` and ${deps.subcategoryCount} subcategor(ies)` : '') +
      '. Deactivate or reassign products first.',
    )
  }

  if (!deps.parentId && deps.subcategoryCount > 0) {
    throw httpError(
      409,
      `Cannot delete this category: ${deps.subcategoryCount} subcategor(ies) still exist. Remove or reassign them first.`,
    )
  }

  return withTransaction(async (client) => {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM categories
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        RETURNING id, parent_id AS "parentId", name
      `,
      [id, branchId],
    )
    if (!rows[0]) throw httpError(404, 'Category not found')
    return { ...rows[0], deleted: true }
  })
}

export async function findOrCreateImportedCategory(tenantId, branchId) {
  if (!branchId) throw httpError(422, 'branchId is required to import products')

  const { rows: existing } = await tenantQuery(
    tenantId,
    `
      SELECT id FROM categories
      WHERE tenant_id = $1 AND branch_id = $2 AND name = 'Imported' AND parent_id IS NULL
      LIMIT 1
    `,
    [branchId],
  )
  if (existing[0]) return existing[0]
  return createCategory(tenantId, { name: 'Imported', branchId })
}

async function attachTaxes(client, tenantId, productId, taxIds = []) {
  await tenantClientQuery(
    client,
    tenantId,
    `DELETE FROM product_taxes WHERE tenant_id = $1 AND product_id = $2`,
    [productId],
  )
  if (!taxIds.length) return

  const uniqueIds = [...new Set(taxIds)]
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT id FROM taxes WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [uniqueIds],
  )
  if (rows.length !== uniqueIds.length) throw httpError(422, 'One or more taxes do not belong to this tenant')

  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO product_taxes (tenant_id, product_id, tax_id)
      SELECT $1, $2, x.tax_id
      FROM unnest($3::uuid[]) AS x(tax_id)
    `,
    [productId, rows.map((row) => row.id)],
  )
}

async function attachBundleItems(client, tenantId, bundleId, bundleItems = [], branchId = null) {
  await tenantClientQuery(
    client,
    tenantId,
    `DELETE FROM bundle_items WHERE tenant_id = $1 AND bundle_id = $2`,
    [bundleId],
  )
  if (!bundleItems.length) return

  if (bundleItems.some((item) => item.itemId === bundleId)) {
    throw httpError(422, 'A bundle cannot contain itself as an item')
  }

  const ids = bundleItems.map((item) => item.itemId)
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id FROM products
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ${branchClause('', 3)}
    `,
    [ids, branchId],
  )
  if (rows.length !== new Set(ids).size) {
    throw httpError(422, 'One or more bundle items do not belong to this branch')
  }

  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO bundle_items (tenant_id, bundle_id, item_id, quantity)
      SELECT $1, $2, x.item_id, x.quantity
      FROM unnest($3::uuid[], $4::numeric[]) AS x(item_id, quantity)
    `,
    [bundleId, ids, bundleItems.map((item) => item.quantity)],
  )
}

// Return remaining finished bundles to component items (deactivate / delete).
async function disassembleBundleFully(
  client,
  tenantId,
  product,
  { createdBy = null, scopeBranchId = null } = {},
) {
  if (!product || product.type !== PRODUCT_TYPES.BUNDLE) return
  const qty = Math.max(0, Number(product.quantity) || 0)
  if (qty <= 0) return
  const items = await loadBundleRecipe(client, tenantId, product.id)
  if (!items.length) return
  // Shared assemble engine (same as Control Stock In top-up)
  await applyBundleAssembleDelta(
    client,
    tenantId,
    {
      bundleId: product.id,
      bundleName: product.name,
      bundleScale: product.scale || 'unit',
      oldBundleQty: qty,
      newBundleQty: 0,
      oldItems: items,
      newItems: items,
      createdBy,
      scopeBranchId,
      branchId: scopeBranchId,
    },
    insertLedgerEventInTx,
  )
}

async function validateProductCategories(client, tenantId, { categoryId, subcategoryId, branchId }) {
  if (categoryId) {
    const { rows: cats } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, is_active AS "isActive", parent_id AS "parentId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2 AND branch_id = $3
        LIMIT 1
      `,
      [categoryId, branchId],
    )
    if (!cats[0]) throw httpError(404, 'Category not found')
    if (!cats[0].isActive) throw httpError(409, 'Cannot assign an inactive category')
    if (cats[0].parentId) throw httpError(400, 'categoryId must be a parent category')
  }
  if (subcategoryId) {
    const { rows: subs } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, is_active AS "isActive", parent_id AS "parentId"
        FROM categories
        WHERE tenant_id = $1 AND id = $2 AND branch_id = $3
        LIMIT 1
      `,
      [subcategoryId, branchId],
    )
    if (!subs[0]) throw httpError(404, 'Subcategory not found')
    if (!subs[0].isActive) throw httpError(409, 'Cannot assign an inactive subcategory')
    if (!subs[0].parentId) throw httpError(400, 'subcategoryId must be a subcategory')
    if (categoryId && subs[0].parentId !== categoryId) {
      throw httpError(400, 'Subcategory does not belong to the selected category')
    }
  }
}

async function resolveBundlePrices(client, tenantId, bundleItems = [], branchId = null) {
  if (!bundleItems.length) return { purchasePrice: 0, sellingPrice: 0 }

  const ids = bundleItems.map((item) => item.itemId)
  const qtyById = new Map(bundleItems.map((item) => [item.itemId, Number(item.quantity) || 1]))

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, purchase_price AS "purchasePrice", selling_price AS "sellingPrice"
      FROM products
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        ${branchClause('', 3)}
    `,
    [ids, branchId],
  )

  let purchasePrice = 0
  let sellingPrice = 0
  for (const row of rows) {
    const qty = qtyById.get(row.id) || 1
    purchasePrice += Number(row.purchasePrice || 0) * qty
    sellingPrice += Number(row.sellingPrice || 0) * qty
  }

  return {
    purchasePrice: Math.round(purchasePrice * 100) / 100,
    sellingPrice: Math.round(sellingPrice * 100) / 100,
  }
}

async function resolveTenantTaxProfitDefaults(client, tenantId) {
  const { rows: tenantRows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        COALESCE(default_profit_percent, 0) AS "defaultProfitPercent",
        COALESCE(default_tax_percent, 0) AS "defaultTaxPercent"
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
  )
  return {
    defaultProfit: Number(tenantRows[0]?.defaultProfitPercent) || 0,
    defaultTax: Number(tenantRows[0]?.defaultTaxPercent) || 0,
  }
}

// as per company code policy — inventory create/update cannot set custom tax percentages;
// only Admin default rate (Apply Default Tax) or explicit exempt (taxIds: []).
function assertImTaxPercentAllowed(taxPercent, defaultTax) {
  if (taxPercent === undefined || taxPercent === null) return
  const rate = Math.round(Number(taxPercent))
  const def = Math.round(Number(defaultTax) || 0)
  if (!Number.isFinite(rate)) {
    throw httpError(422, 'Invalid tax percentage')
  }
  if (rate !== def) {
    throw httpError(
      422,
      'Custom tax percentage is not allowed. Apply Admin default tax or leave the product tax-exempt. Change rates from Admin Tax & Profit.',
    )
  }
}

async function loadProductTaxIds(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT tax_id AS id
      FROM product_taxes
      WHERE tenant_id = $1 AND product_id = $2
      ORDER BY tax_id
    `,
    [productId],
  )
  return rows.map((row) => row.id)
}

// taxPercent (when set) wins over taxIds. Create: omit both → tenant default.
async function resolveTaxIdsForCreate(client, tenantId, { taxIds, taxPercent, defaultTax }) {
  if (taxPercent !== undefined && taxPercent !== null) {
    const taxId = await findOrCreateTaxByRate(tenantId, taxPercent, client)
    return taxId ? [taxId] : []
  }
  if (taxIds !== undefined && taxIds !== null) return taxIds
  if (defaultTax > 0) {
    const defaultTaxId = await findOrCreateTaxByRate(tenantId, defaultTax, client)
    return defaultTaxId ? [defaultTaxId] : []
  }
  return []
}

async function applyOpeningStockInTx(client, tenantId, {
  productId,
  quantity,
  scale,
  unitCost,
  branchId,
  createdBy,
}) {
  const qty = Math.max(0, Number(quantity) || 0)
  if (qty <= 0) return
  await insertLedgerEventInTx(client, tenantId, {
    productId,
    movementType: MOVEMENT_TYPES.IN,
    quantity: qty,
    scale: scale || 'unit',
    reason: 'Opening stock',
    unitCost: unitCost ?? null,
    branchId: branchId || null,
    scopeBranchId: branchId || null,
    createdBy: createdBy || null,
  })
}

async function insertProductRow(client, tenantId, row) {
  // Same as addProduct controller: optional client code, else server generates searchable item_code
  const itemCode = String(row.itemCode || '').trim() || generateItemCode()
  const barcode = String(row.barcode || '').trim() || generateBarcodeValue()

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO products (
        tenant_id, branch_id, category_id, subcategory_id, type, item_code, name, image_url,
        scale, barcode, description, purchase_price, selling_price, profit_percent, offer_id,
        discount_percent, quantity, reorder_point, status, parent_id, creation_batch_id,
        variant_label, daily_price_change, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21,
        $22, $23, COALESCE($24::timestamptz, now())
      )
      RETURNING
        id, name, item_code AS "itemCode", barcode, type, status, branch_id AS "branchId",
        parent_id AS "parentId", creation_batch_id AS "creationBatchId",
        variant_label AS "variantLabel", quantity, reorder_point AS "reorderPoint",
        daily_price_change AS "dailyPriceChange", created_at AS "createdAt"
    `,
    [
      row.branchId,
      row.categoryId || null,
      row.subcategoryId || null,
      row.type,
      itemCode,
      row.name,
      row.imageUrl || null,
      row.scale || 'unit',
      barcode,
      row.description || null,
      row.purchasePrice ?? 0,
      row.sellingPrice ?? 0,
      row.profitPercent ?? 0,
      row.offerId || null,
      row.discountPercent ?? null,
      row.quantity ?? 0,
      row.reorderPoint ?? 10,
      row.status || 'active',
      row.parentId || null,
      row.creationBatchId || null,
      row.variantLabel || null,
      Boolean(row.dailyPriceChange),
      row.createdAt || null,
    ],
  )
  return rows[0]
}

// Upsert into this branch's Variant Management catalog (IM customs reusable next time)
async function upsertVariantType(client, tenantId, branchId, name) {
  const typeName = String(name || '').trim()
  if (!typeName) throw httpError(422, 'Variant type name is required')
  if (!branchId) throw httpError(422, 'branchId is required to save variant types')

  const { rows: existing } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, name
      FROM variant_types
      WHERE tenant_id = $1
        AND branch_id = $2
        AND lower(trim(name)) = lower($3)
      LIMIT 1
    `,
    [branchId, typeName],
  )
  if (existing[0]) {
    return { id: existing[0].id, name: existing[0].name, created: false }
  }

  try {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO variant_types (tenant_id, branch_id, name, is_active)
        VALUES ($1, $2, $3, true)
        RETURNING id, name
      `,
      [branchId, typeName],
    )
    return { id: rows[0].id, name: rows[0].name, created: true }
  } catch (err) {
    if (err?.code !== '23505') throw err
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, name
        FROM variant_types
        WHERE tenant_id = $1
          AND branch_id = $2
          AND lower(trim(name)) = lower($3)
        LIMIT 1
      `,
      [branchId, typeName],
    )
    if (!rows[0]) throw err
    return { id: rows[0].id, name: rows[0].name, created: false }
  }
}

// Upsert value under a type in the same branch catalog
async function upsertVariantValue(client, tenantId, branchId, variantTypeId, name) {
  const valueName = String(name || '').trim()
  if (!valueName) throw httpError(422, 'Variant value name is required')
  if (!branchId) throw httpError(422, 'branchId is required to save variant values')
  if (!variantTypeId) throw httpError(422, 'Variant type is required for value upsert')

  const { rows: existing } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, name
      FROM variant_values
      WHERE tenant_id = $1
        AND branch_id = $2
        AND variant_type_id = $3
        AND lower(trim(name)) = lower($4)
      LIMIT 1
    `,
    [branchId, variantTypeId, valueName],
  )
  if (existing[0]) {
    return { id: existing[0].id, name: existing[0].name, created: false }
  }

  try {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO variant_values (tenant_id, branch_id, variant_type_id, name, is_active)
        VALUES ($1, $2, $3, $4, true)
        RETURNING id, name
      `,
      [branchId, variantTypeId, valueName],
    )
    return { id: rows[0].id, name: rows[0].name, created: true }
  } catch (err) {
    if (err?.code !== '23505') throw err
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, name
        FROM variant_values
        WHERE tenant_id = $1
          AND branch_id = $2
          AND variant_type_id = $3
          AND lower(trim(name)) = lower($4)
        LIMIT 1
      `,
      [branchId, variantTypeId, valueName],
    )
    if (!rows[0]) throw err
    return { id: rows[0].id, name: rows[0].name, created: false }
  }
}

// Merge catalog upserts across SKUs for a single BM notify payload
function recordCatalogAddition(map, { typeId, typeName, typeCreated, valueId, valueName, valueCreated }) {
  if (!typeId || !typeName) return
  let entry = map.get(typeId)
  if (!entry) {
    entry = { typeId, typeName, typeCreated: false, values: new Map() }
    map.set(typeId, entry)
  }
  if (typeCreated) entry.typeCreated = true
  if (valueId && valueName && valueCreated && !entry.values.has(valueId)) {
    entry.values.set(valueId, { id: valueId, name: valueName, created: true })
  }
}

function catalogAdditionsFromMap(map) {
  const out = []
  for (const entry of map.values()) {
    const values = [...entry.values.values()]
    if (!entry.typeCreated && !values.length) continue
    out.push({
      typeId: entry.typeId,
      typeName: entry.typeName,
      typeCreated: entry.typeCreated,
      values,
    })
  }
  return out
}

async function resolveCreatorName(tenantId, userId) {
  if (!userId) return 'Inventory Manager'
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT full_name AS name FROM users WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [userId],
  )
  return rows[0]?.name || 'Inventory Manager'
}

async function notifyCustomVariantCatalog(
  tenantId,
  { productId, productName, createdBy, catalogAdditions, branchId = null },
) {
  if (!catalogAdditions?.length) return
  try {
    const creatorName = await resolveCreatorName(tenantId, createdBy)
    await notifyBranchManagersOfCustomVariants(tenantId, {
      productId,
      productName,
      creatorName,
      additions: catalogAdditions,
      branchId,
    })
    // Admin Logs — IM custom variant type/value (§5.5)
    for (const add of catalogAdditions) {
      const typeName = add.typeName || '—'
      if (add.typeCreated) {
        await writeAdminActivity(tenantId, {
          branchId,
          actorUserId: createdBy,
          category: 'variants',
          action: 'variant_type_create',
          entityType: 'variant_type',
          entityId: add.typeId || null,
          actionText: `Added custom Variant Type "${typeName}" inline while creating product "${productName}". Pending Branch Manager review.`,
          affectedItem: typeName,
        })
      }
      for (const val of add.values || []) {
        const valueName = val.name || val.valueName || '—'
        await writeAdminActivity(tenantId, {
          branchId,
          actorUserId: createdBy,
          category: 'variants',
          action: 'variant_value_create',
          entityType: 'variant_value',
          entityId: val.id || null,
          actionText: `Added custom value "${valueName}" under Variant Type "${typeName}" inline while creating product "${productName}". Pending Branch Manager review.`,
          affectedItem: `${typeName}: ${valueName}`,
        })
      }
    }
  } catch (err) {
    console.error('[products] Failed to notify BMs of custom variants:', err?.message || err)
  }
}

async function attachVariantOptions(
  client,
  tenantId,
  productId,
  parts = [],
  catalogMap = null,
  branchId = null,
) {
  if (!branchId) throw httpError(422, 'branchId is required to attach variant options')

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    const typeName = String(part.typeName || '').trim()
    const valueName = String(part.valueName || '').trim()
    if (!typeName || !valueName) {
      throw httpError(422, 'Each variant part requires typeName and valueName')
    }

    const typeId = isLooseUuid(part.typeId) ? part.typeId : null
    const valueId = isLooseUuid(part.valueId) ? part.valueId : null
    const wantsCustomType = Boolean(part.isCustomType) || !typeId
    const wantsCustomValue = Boolean(part.isCustomValue) || !valueId

    let resolvedTypeId = null
    let resolvedTypeName = typeName
    let typeCreated = false
    let resolvedValueId = null
    let resolvedValueName = valueName
    let valueCreated = false

    // Prefer catalog UUID when client selected an existing type in this branch
    if (typeId && !wantsCustomType) {
      const { rows } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT id, name
          FROM variant_types
          WHERE tenant_id = $1 AND id = $2 AND branch_id = $3
          LIMIT 1
        `,
        [typeId, branchId],
      )
      if (rows[0]) {
        resolvedTypeId = rows[0].id
        resolvedTypeName = rows[0].name
      }
    }

    // Custom / missing type → save into this branch's Variant Management
    if (!resolvedTypeId) {
      const upserted = await upsertVariantType(client, tenantId, branchId, typeName)
      resolvedTypeId = upserted.id
      resolvedTypeName = upserted.name
      typeCreated = upserted.created
    }

    if (valueId && !wantsCustomValue) {
      const { rows } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT id, name
          FROM variant_values
          WHERE tenant_id = $1 AND id = $2 AND branch_id = $3
            AND ($4::uuid IS NULL OR variant_type_id = $4)
          LIMIT 1
        `,
        [valueId, branchId, resolvedTypeId],
      )
      if (rows[0]) {
        resolvedValueId = rows[0].id
        resolvedValueName = rows[0].name
      }
    }

    // Custom / missing value → save under type in this branch catalog
    if (!resolvedValueId) {
      const upserted = await upsertVariantValue(
        client,
        tenantId,
        branchId,
        resolvedTypeId,
        valueName,
      )
      resolvedValueId = upserted.id
      resolvedValueName = upserted.name
      valueCreated = upserted.created
    }

    if (catalogMap) {
      recordCatalogAddition(catalogMap, {
        typeId: resolvedTypeId,
        typeName: resolvedTypeName,
        typeCreated,
        valueId: resolvedValueId,
        valueName: resolvedValueName,
        valueCreated,
      })
    }

    await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO product_variant_options (
          tenant_id, product_id, sort_order, variant_type_id, variant_value_id,
          type_name, value_name, is_custom_type, is_custom_value
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        productId,
        i,
        resolvedTypeId,
        resolvedValueId,
        resolvedTypeName,
        resolvedValueName,
        // Origin flags — FKs always point at catalog after upsert
        wantsCustomType,
        wantsCustomValue,
      ],
    )
  }
}

export async function createVariantProduct(tenantId, payload) {
  if (!payload.branchId) throw httpError(422, 'branchId is required to create a product')
  const variants = Array.isArray(payload.variants) ? payload.variants : []
  if (!variants.length) throw httpError(422, 'Variant products require at least one combination')

  try {
    const catalogMap = new Map()
    const created = await withTransaction(async (client) => {
      if (payload.categoryId || payload.subcategoryId) {
        await validateProductCategories(client, tenantId, {
          categoryId: payload.categoryId,
          subcategoryId: payload.subcategoryId,
          branchId: payload.branchId,
        })
        if (payload.subcategoryId && !payload.categoryId) {
          throw httpError(400, 'categoryId is required when subcategoryId is set')
        }
      }

      const { defaultProfit, defaultTax } = await resolveTenantTaxProfitDefaults(client, tenantId)
      // as per company code policy — profit % is Admin-owned (tenant default on create)
      const profitPercent = defaultProfit
      assertImTaxPercentAllowed(payload.taxPercent, defaultTax)
      const resolvedTaxIds = await resolveTaxIdsForCreate(client, tenantId, {
        taxIds: payload.taxIds,
        taxPercent: payload.taxPercent,
        defaultTax,
      })

      const createdAt = payload.createdAt || new Date().toISOString()
      const creationBatchId = payload.creationBatchId || crypto.randomUUID()
      const scale = payload.scale || 'unit'

      // Parent holds shared name/category — no sellable stock
      const parent = await insertProductRow(client, tenantId, {
        branchId: payload.branchId,
        categoryId: payload.categoryId,
        subcategoryId: payload.subcategoryId,
        type: PRODUCT_TYPES.VARIANT,
        itemCode: payload.itemCode,
        name: payload.name,
        imageUrl: payload.imageUrl,
        scale,
        barcode: payload.barcode,
        description: payload.description,
        purchasePrice: 0,
        sellingPrice: 0,
        profitPercent,
        offerId: payload.offerId,
        discountPercent: payload.discountPercent,
        quantity: 0,
        reorderPoint: payload.reorderPoint ?? 10,
        status: 'active',
        creationBatchId,
        createdAt,
        dailyPriceChange: false,
      })
      await attachTaxes(client, tenantId, parent.id, resolvedTaxIds)

      const children = []
      for (const [index, variant] of variants.entries()) {
        const label = String(variant.label || '').trim()
        if (!label) throw httpError(422, `Variant #${index + 1}: label is required`)
        const itemCode =
          String(variant.itemCode || variant.sku || '').trim() ||
          `${generateItemCode()}-${index + 1}`
        const barcode =
          String(variant.barcode || '').trim() ||
          `${generateBarcodeValue().slice(0, 11)}${String(index + 1).padStart(2, '0')}`

        const purchasePrice = Math.round(Number(variant.purchasePrice) || 0)
        let sellingPrice = Math.round(Number(variant.sellingPrice) || 0)
        if ((!sellingPrice || sellingPrice === 0) && purchasePrice > 0 && profitPercent > 0) {
          sellingPrice = sellingFromPurchase(purchasePrice, profitPercent)
        }
        assertSellingGtePurchase(purchasePrice, sellingPrice, `Variant “${label}”`)
        const promo = resolveVariantPromo(variant, payload)

        const childStatus = variant.status === 'inactive' ? 'inactive' : 'active'
        const openingQty =
          childStatus === 'inactive' ? 0 : Math.max(0, Number(variant.quantity) || 0)
        const child = await insertProductRow(client, tenantId, {
          branchId: payload.branchId,
          categoryId: payload.categoryId,
          subcategoryId: payload.subcategoryId,
          type: PRODUCT_TYPES.SINGLE,
          itemCode,
          name: payload.name,
          // Per-SKU image when provided; otherwise inherit parent
          imageUrl: variant.imageUrl || payload.imageUrl || null,
          scale,
          barcode,
          description: payload.description,
          purchasePrice,
          sellingPrice,
          profitPercent,
          offerId: promo.offerId,
          discountPercent: promo.discountPercent,
          quantity: 0,
          reorderPoint:
            variant.reorderPoint === undefined || variant.reorderPoint === null
              ? 10
              : Number(variant.reorderPoint),
          status: childStatus,
          parentId: parent.id,
          creationBatchId,
          variantLabel: label,
          dailyPriceChange: Boolean(variant.dailyPriceChange),
          createdAt,
        })

        await attachTaxes(client, tenantId, child.id, resolvedTaxIds)
        await attachVariantOptions(
          client,
          tenantId,
          child.id,
          variant.parts || [],
          catalogMap,
          payload.branchId,
        )
        await applyOpeningStockInTx(client, tenantId, {
          productId: child.id,
          quantity: openingQty,
          scale,
          unitCost: purchasePrice,
          branchId: payload.branchId,
          createdBy: payload.createdBy,
        })

        children.push({
          ...child,
          label,
          parts: variant.parts || [],
        })
      }

      await logProductActivity(client, tenantId, {
        branchId: payload.branchId,
        actorUserId: payload.createdBy,
        category: 'products',
        actionText: newOffer,
        action: 'product_create',
        entityType: 'product',
        entityId: parent.id,
        actionText: `Added new Variant product "${parent.name}" with ${children.length} combination(s).`,
        affectedItem: parent.name,
      })

      return {
        ...parent,
        creationBatchId,
        variants: children,
      }
    })

    await notifyCustomVariantCatalog(tenantId, {
      productId: created.id,
      productName: created.name,
      createdBy: payload.createdBy,
      catalogAdditions: catalogAdditionsFromMap(catalogMap),
      branchId: payload.branchId || created.branchId || null,
    })

    return created
  } catch (err) {
    mapUniqueViolation(err, 'A variant SKU or barcode already exists in this branch')
  }
}

export async function createProduct(tenantId, payload) {
  if (!payload.branchId) throw httpError(422, 'branchId is required to create a product')

  if (payload.type === PRODUCT_TYPES.VARIANT) {
    return createVariantProduct(tenantId, payload)
  }

  try {
    return await withTransaction(async (client) => {
      if (payload.categoryId || payload.subcategoryId) {
        await validateProductCategories(client, tenantId, {
          categoryId: payload.categoryId,
          subcategoryId: payload.subcategoryId,
          branchId: payload.branchId,
        })
        if (payload.subcategoryId && !payload.categoryId) {
          throw httpError(400, 'categoryId is required when subcategoryId is set')
        }
      }

      const { defaultProfit, defaultTax } = await resolveTenantTaxProfitDefaults(client, tenantId)
      // as per company code policy — profit % is Admin-owned (tenant default on create)
      const profitPercent = defaultProfit
      assertImTaxPercentAllowed(payload.taxPercent, defaultTax)

      let purchasePrice = payload.purchasePrice ?? 0
      let sellingPrice = payload.sellingPrice ?? 0
      if (payload.type === PRODUCT_TYPES.BUNDLE && payload.bundleItems?.length) {
        const derived = await resolveBundlePrices(
          client,
          tenantId,
          payload.bundleItems,
          payload.branchId,
        )
        purchasePrice = derived.purchasePrice
        const requestedSelling = Number(payload.sellingPrice)
        sellingPrice = requestedSelling > 0 ? requestedSelling : derived.sellingPrice
      } else if ((!sellingPrice || sellingPrice === 0) && purchasePrice > 0 && profitPercent > 0) {
        sellingPrice = sellingFromPurchase(purchasePrice, profitPercent)
      }

      purchasePrice = Math.round(Number(purchasePrice) || 0)
      sellingPrice = Math.round(Number(sellingPrice) || 0)
      if (payload.type !== PRODUCT_TYPES.BUNDLE) {
        assertSellingGtePurchase(purchasePrice, sellingPrice, payload.name || 'Product')
      }

      const isBundle = payload.type === PRODUCT_TYPES.BUNDLE
      const openingQty = isBundle ? 0 : Math.max(0, Number(payload.quantity) || 0)

      const product = await insertProductRow(client, tenantId, {
        branchId: payload.branchId,
        categoryId: payload.categoryId,
        subcategoryId: payload.subcategoryId,
        type: payload.type,
        itemCode: payload.itemCode,
        name: payload.name,
        imageUrl: payload.imageUrl,
        scale: payload.scale || 'unit',
        barcode: payload.barcode,
        description: payload.description,
        purchasePrice,
        sellingPrice,
        profitPercent,
        offerId: payload.offerId || null,
        discountPercent:
          payload.discountPercent === undefined || payload.discountPercent === ''
            ? null
            : payload.discountPercent,
        // Opening stock applied via ledger so qty + branch_inventory stay consistent
        quantity: 0,
        reorderPoint:
          payload.reorderPoint === undefined || payload.reorderPoint === null
            ? 10
            : Number(payload.reorderPoint),
        status: payload.status === 'inactive' ? 'inactive' : 'active',
        dailyPriceChange: Boolean(payload.dailyPriceChange),
      })

      const resolvedTaxIds = await resolveTaxIdsForCreate(client, tenantId, {
        taxIds: payload.taxIds,
        taxPercent: payload.taxPercent,
        defaultTax,
      })
      await attachTaxes(client, tenantId, product.id, resolvedTaxIds)

      if (isBundle) {
        const bundleItems = payload.bundleItems || []
        await attachBundleItems(client, tenantId, product.id, bundleItems, payload.branchId)
        const finishedQty = Math.max(0, Number(payload.quantity) || 0)
        if (finishedQty > 0 || bundleItems.length) {
          await applyBundleAssembleDelta(
            client,
            tenantId,
            {
              bundleId: product.id,
              bundleName: product.name,
              bundleScale: payload.scale || 'unit',
              oldBundleQty: 0,
              newBundleQty: finishedQty,
              oldItems: [],
              newItems: bundleItems,
              createdBy: payload.createdBy || null,
              scopeBranchId: payload.branchId || null,
              branchId: payload.branchId || null,
            },
            insertLedgerEventInTx,
          )
        }
      } else {
        await applyOpeningStockInTx(client, tenantId, {
          productId: product.id,
          quantity: openingQty,
          scale: payload.scale || 'unit',
          unitCost: purchasePrice,
          branchId: payload.branchId,
          createdBy: payload.createdBy,
        })
      }

      // Admin Logs — product / bundle create (§5.3 / §5.4)
      if (isBundle) {
        const n = (payload.bundleItems || []).length
        const qty = Math.max(0, Number(payload.quantity) || 0)
        await logProductActivity(client, tenantId, {
          branchId: payload.branchId,
          actorUserId: payload.createdBy,
          category: 'bundles',
          action: 'bundle_create',
          entityType: 'product',
          entityId: product.id,
          actionText: `Created bundle "${product.name}" with ${n} items and stock of ${qty} units.`,
          affectedItem: product.name,
        })
      } else {
        const kind = payload.type === PRODUCT_TYPES.VARIANT ? 'Variant' : 'Normal'
        await logProductActivity(client, tenantId, {
          branchId: payload.branchId,
          actorUserId: payload.createdBy,
          category: 'products',
          action: 'product_create',
          entityType: 'product',
          entityId: product.id,
          actionText: `Added new ${kind} product "${product.name}".`,
          affectedItem: product.name,
        })
      }

      return product
    })
  } catch (err) {
    mapUniqueViolation(err)
  }
}

// Maps camelCase payload keys to SQL column names. Columns whose values can
// legitimately be NULLed by the caller are included here; simple-string fields
// that cannot be set to NULL intentionally are also listed.
const UPDATABLE_COLUMNS = {
  name: 'name',
  categoryId: 'category_id',
  subcategoryId: 'subcategory_id',
  status: 'status',
  scale: 'scale',
  description: 'description',
  purchasePrice: 'purchase_price',
  sellingPrice: 'selling_price',
  profitPercent: 'profit_percent',
  discountPercent: 'discount_percent',
  offerId: 'offer_id',
  imageUrl: 'image_url',
  itemCode: 'item_code',
  barcode: 'barcode',
  reorderPoint: 'reorder_point',
  dailyPriceChange: 'daily_price_change',
}

async function syncVariantChildrenInTx(
  client,
  tenantId,
  parent,
  payload,
  { branchId, createdBy, catalogMap = null } = {},
) {
  const variants = Array.isArray(payload.variants) ? payload.variants : []
  if (!variants.length) throw httpError(422, 'Variant products require at least one combination')

  const effectiveBranchId = parent.branchId || branchId
  const parentName = payload.name || parent.name
  const parentScale = payload.scale || parent.scale || 'unit'
  // Fallback when a SKU has no image of its own
  const parentImageUrl =
    payload.imageUrl !== undefined ? payload.imageUrl || null : parent.imageUrl || null
  const creationBatchId = parent.creationBatchId || crypto.randomUUID()
  const createdAt = new Date().toISOString()

  // Inherit parent category when not patched on this request
  const categoryId =
    'categoryId' in payload ? payload.categoryId ?? null : parent.categoryId
  const subcategoryId =
    'subcategoryId' in payload ? payload.subcategoryId ?? null : parent.subcategoryId

  // Edit path: inherit parent taxes for new SKUs (do not re-apply tenant defaults).
  // taxPercent on the parent patch resolves to taxIds first (see updateProduct).
  const resolvedTaxIds =
    payload.taxIds !== undefined
      ? payload.taxIds
      : await loadProductTaxIds(client, tenantId, parent.id)
  const childProfitPercent =
    payload.profitPercent !== undefined
      ? Number(payload.profitPercent)
      : Number(parent.profitPercent) || 0

  const children = []
  for (const [index, variant] of variants.entries()) {
    const label = String(variant.label || '').trim()
    if (!label) throw httpError(422, `Variant #${index + 1}: label is required`)
    let itemCode = String(variant.itemCode || variant.sku || '').trim()
    let barcode = String(variant.barcode || '').trim()

    const purchasePrice = Math.round(Number(variant.purchasePrice) || 0)
    const sellingPrice = Math.round(Number(variant.sellingPrice) || 0)
    assertSellingGtePurchase(purchasePrice, sellingPrice, `Variant “${label}”`)
    const promo = resolveVariantPromo(variant, payload)
    const childStatus = variant.status === 'inactive' ? 'inactive' : 'active'
    const reorderPoint =
      variant.reorderPoint === undefined || variant.reorderPoint === null
        ? 10
        : Number(variant.reorderPoint)

    if (variant.id) {
      // Existing child — update fields; stock stays via Control
      const { rows: owned } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT
            id,
            item_code AS "itemCode",
            barcode,
            image_url AS "imageUrl",
            daily_price_change AS "dailyPriceChange",
            purchase_price AS "purchasePrice",
            selling_price AS "sellingPrice"
          FROM products
          WHERE tenant_id = $1 AND id = $2 AND parent_id = $3
          LIMIT 1
        `,
        [variant.id, parent.id],
      )
      if (!owned[0]) {
        throw httpError(404, `Variant SKU not found under this product (${label})`)
      }
      itemCode = itemCode || owned[0].itemCode
      barcode = barcode || owned[0].barcode
      // Keep existing SKU image unless this variant payload sets imageUrl
      const childImageUrl =
        variant.imageUrl !== undefined
          ? variant.imageUrl || null
          : owned[0].imageUrl || parentImageUrl

      const nextDaily = Boolean(variant.dailyPriceChange)
      const wasDaily = Boolean(owned[0].dailyPriceChange)
      const pricesChanged =
        Number(owned[0].purchasePrice) !== Number(purchasePrice) ||
        Number(owned[0].sellingPrice) !== Number(sellingPrice)
      // Enable → pending (NULL). Already-on + price edit → stamped today.
      // Otherwise omit the column so the old stamp is kept.
      let dailyUpdatedOnSql = ''
      if (nextDaily && !wasDaily) {
        dailyUpdatedOnSql = 'daily_price_updated_on = NULL,'
      } else if (nextDaily && pricesChanged) {
        dailyUpdatedOnSql = 'daily_price_updated_on = CURRENT_DATE,'
      }
      await tenantClientQuery(
        client,
        tenantId,
        `
    UPDATE products SET
      name = $3,
      item_code = $4,
      barcode = $5,
      purchase_price = $6,
      last_selling_price = CASE
        WHEN selling_price IS DISTINCT FROM $7::numeric THEN selling_price
        ELSE last_selling_price
      END,
      selling_price = $7::numeric,
      reorder_point = $8,
      daily_price_change = $9::boolean,
      ${dailyUpdatedOnSql}
      status = $10,
      variant_label = $11,
      category_id = $12,
      subcategory_id = $13,
      image_url = $14,
      offer_id = $15,
      discount_percent = $16::numeric,
      profit_percent = $17::numeric,
      updated_at = now()
    WHERE tenant_id = $1 AND id = $2
  `,
        [
          variant.id,
          parentName,
          itemCode,
          barcode,
          purchasePrice,
          sellingPrice,
          reorderPoint,
          nextDaily,
          childStatus,
          label,
          categoryId,
          subcategoryId,
          childImageUrl,
          promo.offerId,
          promo.discountPercent,
          childProfitPercent,
        ],
      )

      // Replace option parts
      await tenantClientQuery(
        client,
        tenantId,
        `DELETE FROM product_variant_options WHERE tenant_id = $1 AND product_id = $2`,
        [variant.id],
      )
      await attachVariantOptions(
        client,
        tenantId,
        variant.id,
        variant.parts || [],
        catalogMap,
        effectiveBranchId,
      )
      if (payload.taxIds !== undefined) {
        await attachTaxes(client, tenantId, variant.id, resolvedTaxIds)
      }

      children.push({ id: variant.id, label, itemCode, barcode })
    } else {
      // New combination — system generates codes when omitted
      itemCode = itemCode || `${generateItemCode()}-${index + 1}`
      barcode =
        barcode ||
        `${generateBarcodeValue().slice(0, 11)}${String(index + 1).padStart(2, '0')}`

      const child = await insertProductRow(client, tenantId, {
        branchId: effectiveBranchId,
        categoryId,
        subcategoryId,
        type: PRODUCT_TYPES.SINGLE,
        itemCode,
        name: parentName,
        imageUrl: variant.imageUrl || parentImageUrl,
        scale: parentScale,
        barcode,
        description: payload.description !== undefined ? payload.description : parent.description,
        purchasePrice,
        sellingPrice,
        profitPercent: childProfitPercent,
        offerId: promo.offerId,
        discountPercent: promo.discountPercent,
        quantity: 0,
        reorderPoint,
        status: childStatus,
        parentId: parent.id,
        creationBatchId,
        variantLabel: label,
        dailyPriceChange: Boolean(variant.dailyPriceChange),
        createdAt,
      })
      await attachTaxes(client, tenantId, child.id, resolvedTaxIds)
      await attachVariantOptions(
        client,
        tenantId,
        child.id,
        variant.parts || [],
        catalogMap,
        effectiveBranchId,
      )

      const openingQty =
        childStatus === 'inactive' ? 0 : Math.max(0, Number(variant.quantity) || 0)
      await applyOpeningStockInTx(client, tenantId, {
        productId: child.id,
        quantity: openingQty,
        scale: parentScale,
        unitCost: purchasePrice,
        branchId: effectiveBranchId,
        createdBy,
      })

      children.push({ id: child.id, label, itemCode, barcode })
    }
  }

  return children
}

export async function updateProduct(tenantId, id, payload, { branchId = null } = {}) {
  // Normalize sku → itemCode
  if (payload.sku && !payload.itemCode) payload.itemCode = payload.sku

  try {
    const catalogMap = new Map()
    const updated = await withTransaction(async (client) => {
      const { rows: existingRows } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT
            id,
            name,
            type,
            scale,
            status,
            category_id AS "categoryId",
            subcategory_id AS "subcategoryId",
            branch_id AS "branchId",
            quantity,
            purchase_price AS "purchasePrice",
            selling_price AS "sellingPrice",
            offer_id AS "offerId",
            image_url AS "imageUrl",
            description,
            creation_batch_id AS "creationBatchId",
            profit_percent AS "profitPercent",
            parent_id AS "parentId",
            daily_price_change AS "dailyPriceChange"
          FROM products
          WHERE tenant_id = $1 AND id = $2
            ${branchClause('', 3)}
          LIMIT 1
        `,
        [id, branchId],
      )
      const existing = existingRows[0]
      if (!existing) return null

      // Child SKUs: allow image-only PATCH; all other edits go through the parent
      if (existing.parentId) {
        const writeKeys = Object.keys(payload).filter(
          (key) =>
            payload[key] !== undefined &&
            key !== 'createdBy' &&
            key !== 'branchId' &&
            key !== 'confirmed',
        )
        const imageOnly =
          writeKeys.length > 0 && writeKeys.every((key) => key === 'imageUrl')
        if (!imageOnly) {
          throw httpError(400, 'Edit the parent variant product to update this SKU')
        }
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE products
            SET image_url = $3, updated_at = now()
            WHERE tenant_id = $1 AND id = $2
          `,
          [id, payload.imageUrl || null],
        )
        return {
          id: existing.id,
          name: existing.name,
          imageUrl: payload.imageUrl || null,
          parentId: existing.parentId,
        }
      }

      // TL: recipe locked after create — top-up stock only via quantity
      if (existing.type === PRODUCT_TYPES.BUNDLE && payload.bundleItems !== undefined) {
        throw httpError(
          400,
          'Bundle items cannot be changed after creation. Delete and recreate the bundle.',
        )
      }

      // Product type is locked after create (Normal ↔ Variant blocked)
      if (payload.type != null && payload.type !== existing.type) {
        throw httpError(
          400,
          'Product type cannot be changed after creation. Deactivate this product and create a new one.',
        )
      }
      // Ignore type on update so clients cannot mutate it via UPDATABLE_COLUMNS later
      if ('type' in payload) delete payload.type

      // Utilization-gated price: block purchase/sell changes while on-hand remains.
      if ('purchasePrice' in payload || 'sellingPrice' in payload) {
        await assertPriceChangeAllowed(client, tenantId, id, {
          purchasePrice: 'purchasePrice' in payload ? payload.purchasePrice : undefined,
          sellingPrice: 'sellingPrice' in payload ? payload.sellingPrice : undefined,
        })
        const nextPurchase =
          'purchasePrice' in payload ? payload.purchasePrice : existing.purchasePrice
        const nextSelling =
          'sellingPrice' in payload ? payload.sellingPrice : existing.sellingPrice
        if (existing.type !== PRODUCT_TYPES.BUNDLE) {
          assertSellingGtePurchase(nextPurchase, nextSelling, existing.name || 'Product')
        }
      }

      const effectiveBranchId = existing.branchId || branchId
      const hasCategoryPatch = 'categoryId' in payload || 'subcategoryId' in payload

      if (hasCategoryPatch) {
        const nextCategoryId =
          'categoryId' in payload ? payload.categoryId ?? null : existing.categoryId
        const nextSubcategoryId =
          'subcategoryId' in payload ? payload.subcategoryId ?? null : undefined

        if (nextSubcategoryId && !nextCategoryId) {
          throw httpError(400, 'categoryId is required when subcategoryId is set')
        }

        if (nextCategoryId || nextSubcategoryId) {
          await validateProductCategories(client, tenantId, {
            categoryId: nextCategoryId,
            subcategoryId: nextSubcategoryId,
            branchId: effectiveBranchId,
          })
        }

        if (
          'categoryId' in payload &&
          !('subcategoryId' in payload) &&
          payload.categoryId !== existing.categoryId
        ) {
          payload.subcategoryId = null
        }
      }

      // Non-bundle: stock is Control-only (ignore quantity on update)
      if (existing.type !== PRODUCT_TYPES.BUNDLE && 'quantity' in payload) {
        delete payload.quantity
      }

      // as per company code policy — profit % changes only via Admin Tax & Profit bulk
      if ('profitPercent' in payload) {
        delete payload.profitPercent
      }

      const { defaultTax } = await resolveTenantTaxProfitDefaults(client, tenantId)
      assertImTaxPercentAllowed(payload.taxPercent, defaultTax)

      // taxPercent → taxIds (find-or-create); takes precedence over explicit taxIds
      if (payload.taxPercent !== undefined && payload.taxPercent !== null) {
        payload.taxIds = await resolveTaxIdsForCreate(client, tenantId, {
          taxPercent: payload.taxPercent,
          defaultTax: 0,
        })
      }

      const setClauses = []
      const params = [id, branchId]

      for (const [payloadKey, column] of Object.entries(UPDATABLE_COLUMNS)) {
        if (!(payloadKey in payload)) continue

        const paramIndex = params.length + 2
        const value = payload[payloadKey] ?? null

        if (payloadKey === 'sellingPrice') {
          setClauses.push(`
          last_selling_price = CASE
            WHEN $${paramIndex}::numeric IS NOT NULL AND selling_price IS DISTINCT FROM $${paramIndex}::numeric
              THEN selling_price
            ELSE last_selling_price
          END,
          selling_price = $${paramIndex}::numeric`)
        } else if (payloadKey === 'purchasePrice') {
          setClauses.push(`purchase_price = $${paramIndex}::numeric`)
        } else if (payloadKey === 'discountPercent') {
          setClauses.push(`discount_percent = $${paramIndex}::numeric`)
        } else if (payloadKey === 'profitPercent') {
          setClauses.push(`profit_percent = $${paramIndex}::numeric`)
        } else if (payloadKey === 'offerId') {
          setClauses.push(`offer_id = $${paramIndex}::uuid`)
        } else if (payloadKey === 'categoryId') {
          setClauses.push(`category_id = $${paramIndex}::uuid`)
        } else if (payloadKey === 'subcategoryId') {
          setClauses.push(`subcategory_id = $${paramIndex}::uuid`)
        } else if (payloadKey === 'imageUrl') {
          setClauses.push(`image_url = $${paramIndex}`)
        } else if (payloadKey === 'reorderPoint') {
          setClauses.push(`reorder_point = $${paramIndex}::numeric`)
        } else if (payloadKey === 'dailyPriceChange') {
          const enabled = Boolean(value)
          setClauses.push(`daily_price_change = $${paramIndex}::boolean`)
          params.push(enabled)
          // Only on false→true: clear stamp so SKU joins today's pending queue
          if (enabled && !Boolean(existing.dailyPriceChange)) {
            setClauses.push('daily_price_updated_on = NULL')
          }
          continue
        } else {
          setClauses.push(`${column} = $${paramIndex}`)
        }

        params.push(value)
      }

      const hasVariantSync =
        existing.type === PRODUCT_TYPES.VARIANT && Array.isArray(payload.variants)

      if (
        !setClauses.length &&
        payload.taxIds === undefined &&
        !payload.bundleItems &&
        !('quantity' in payload) &&
        !hasVariantSync
      ) {
        const { rows: current } = await tenantClientQuery(
          client,
          tenantId,
          `
            SELECT id, name, status, branch_id AS "branchId",
              category_id AS "categoryId", subcategory_id AS "subcategoryId"
            FROM products
            WHERE tenant_id = $1 AND id = $2
              ${branchClause('', 3)}
          `,
          [id, branchId],
        )
        return current[0] || null
      }

      let product = null

      if (setClauses.length) {
        setClauses.push('updated_at = now()')
        // Daily-price products: mark today's price review when purchase/sell changes.
        if ('purchasePrice' in payload || 'sellingPrice' in payload) {
          setClauses.push(`
            daily_price_updated_on = CASE
              WHEN daily_price_change THEN CURRENT_DATE
              ELSE daily_price_updated_on
            END`)
        }
        const { rows } = await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE products SET ${setClauses.join(', ')}
            WHERE tenant_id = $1 AND id = $2
              ${branchClause('', 3)}
            RETURNING id, name, status, branch_id AS "branchId",
              category_id AS "categoryId", subcategory_id AS "subcategoryId"
          `,
          params,
        )
        product = rows[0] || null
        if (!product) return null
      } else {
        const { rows } = await tenantClientQuery(
          client,
          tenantId,
          `
            SELECT id, name, status, branch_id AS "branchId",
              category_id AS "categoryId", subcategory_id AS "subcategoryId"
            FROM products
            WHERE tenant_id = $1 AND id = $2
              ${branchClause('', 3)}
          `,
          [id, branchId],
        )
        product = rows[0] || null
        if (!product) return null
      }

      if (payload.taxIds !== undefined) await attachTaxes(client, tenantId, id, payload.taxIds)

      const isBundle = existing.type === PRODUCT_TYPES.BUNDLE
      const qtyChanging = isBundle && 'quantity' in payload
      const nextStatus =
        payload.status !== undefined ? payload.status : existing.status
      const becomingInactive =
        isBundle &&
        existing.status !== PRODUCT_STATUS.INACTIVE &&
        nextStatus === PRODUCT_STATUS.INACTIVE

      // Deactivate → dissolve remaining finished stock back to components
      if (becomingInactive) {
        await disassembleBundleFully(client, tenantId, existing, {
          createdBy: payload.createdBy || null,
          scopeBranchId: product.branchId || branchId || null,
        })
      } else if (qtyChanging) {
        const oldItems = await loadBundleRecipe(client, tenantId, id)
        const newBundleQty = Math.max(0, Number(payload.quantity) || 0)
        const bundleName = payload.name || existing.name
        const bundleScale = payload.scale || existing.scale || 'unit'

        await applyBundleAssembleDelta(
          client,
          tenantId,
          {
            bundleId: id,
            bundleName,
            bundleScale,
            oldBundleQty: Number(existing.quantity) || 0,
            newBundleQty,
            oldItems,
            newItems: oldItems,
            createdBy: payload.createdBy || null,
            scopeBranchId: product.branchId || branchId || null,
            branchId: product.branchId || branchId || null,
          },
          insertLedgerEventInTx,
        )
      }

      let syncedVariants = null
      if (hasVariantSync) {
        const parentForSync = {
          ...existing,
          profitPercent:
            payload.profitPercent !== undefined
              ? Number(payload.profitPercent)
              : existing.profitPercent,
        }
        syncedVariants = await syncVariantChildrenInTx(client, tenantId, parentForSync, payload, {
          branchId: effectiveBranchId,
          createdBy: payload.createdBy || null,
          catalogMap,
        })

        // Keep child display names in sync when parent name changes
        if (payload.name) {
          await tenantClientQuery(
            client,
            tenantId,
            `
              UPDATE products
              SET name = $3, updated_at = now()
              WHERE tenant_id = $1 AND parent_id = $2
            `,
            [id, payload.name],
          )
        }
      } else if (
        existing.type === PRODUCT_TYPES.VARIANT &&
        (payload.profitPercent !== undefined || payload.taxIds !== undefined)
      ) {
        // Parent-only patch (no variants array): still sync tax/profit to SKUs
        if (payload.profitPercent !== undefined) {
          await tenantClientQuery(
            client,
            tenantId,
            `
              UPDATE products
              SET profit_percent = $3::numeric, updated_at = now()
              WHERE tenant_id = $1 AND parent_id = $2
            `,
            [id, Number(payload.profitPercent)],
          )
        }
        if (payload.taxIds !== undefined) {
          const { rows: childRows } = await tenantClientQuery(
            client,
            tenantId,
            `SELECT id FROM products WHERE tenant_id = $1 AND parent_id = $2`,
            [id],
          )
          for (const child of childRows) {
            await attachTaxes(client, tenantId, child.id, payload.taxIds)
          }
        }
      }

      // Parent image fills empty SKU images only — never overwrite per-SKU uploads
      if (
        existing.type === PRODUCT_TYPES.VARIANT &&
        payload.imageUrl !== undefined
      ) {
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE products
            SET image_url = $3, updated_at = now()
            WHERE tenant_id = $1
              AND parent_id = $2
              AND (image_url IS NULL OR image_url = '')
          `,
          [id, payload.imageUrl || null],
        )
      }

      // Admin Logs — products / bundles / pricing on update (§5.2–5.4)
      const branchIdForLog = product.branchId || branchId || payload.branchId
      const actorUserId = payload.createdBy || null
      const displayName = product.name || existing.name
      const isBundleType = existing.type === PRODUCT_TYPES.BUNDLE

      if (becomingInactive) {
        await logProductActivity(client, tenantId, {
          branchId: branchIdForLog,
          actorUserId,
          category: isBundleType ? 'bundles' : 'products',
          action: isBundleType ? 'bundle_deactivate' : 'product_deactivate',
          entityType: 'product',
          entityId: id,
          actionText: isBundleType
            ? `Deactivated bundle "${displayName}". Remaining units dissolved; stock returned to component items.`
            : `Deactivated product "${displayName}".`,
          affectedItem: displayName,
        })
      } else if (
        existing.status === PRODUCT_STATUS.INACTIVE &&
        nextStatus === PRODUCT_STATUS.ACTIVE
      ) {
        await logProductActivity(client, tenantId, {
          branchId: branchIdForLog,
          actorUserId,
          category: 'products',
          action: 'product_reactivate',
          entityType: 'product',
          entityId: id,
          actionText: `Reactivated product "${displayName}".`,
          affectedItem: displayName,
        })
      }

      if (qtyChanging && !becomingInactive) {
        const added =
          Math.max(0, Number(payload.quantity) || 0) - (Number(existing.quantity) || 0)
        if (added > 0) {
          await logProductActivity(client, tenantId, {
            branchId: branchIdForLog,
            actorUserId,
            category: 'bundles',
            action: 'bundle_top_up',
            entityType: 'product',
            entityId: id,
            actionText: `Added ${added} additional units to bundle "${displayName}". New stock: ${Math.max(0, Number(payload.quantity) || 0)}.`,
            affectedItem: displayName,
          })
        }
      }

      const oldSell = Number(existing.sellingPrice)
      const newSell =
        payload.sellingPrice !== undefined ? Number(payload.sellingPrice) : oldSell
      const oldBuy = Number(existing.purchasePrice)
      const newBuy =
        payload.purchasePrice !== undefined ? Number(payload.purchasePrice) : oldBuy

      if (
        (payload.sellingPrice !== undefined && newSell !== oldSell) ||
        (!isBundleType && payload.purchasePrice !== undefined && newBuy !== oldBuy)
      ) {
        const currency = await getTenantCurrencyCode(tenantId)
        if (payload.sellingPrice !== undefined && newSell !== oldSell) {
          await logProductActivity(client, tenantId, {
            branchId: branchIdForLog,
            actorUserId,
            category: isBundleType ? 'bundles' : 'pricing',
            action: isBundleType ? 'bundle_price_change' : 'selling_price_change',
            entityType: 'product',
            entityId: id,
            actionText: isBundleType
              ? `Changed price of bundle "${displayName}" from ${formatMoneyLabel(oldSell, currency)} to ${formatMoneyLabel(newSell, currency)}.`
              : `Changed selling price of ${displayName} from ${formatMoneyLabel(oldSell, currency)} to ${formatMoneyLabel(newSell, currency)}.`,
            affectedItem: displayName,
          })
        }
        if (!isBundleType && payload.purchasePrice !== undefined && newBuy !== oldBuy) {
          await logProductActivity(client, tenantId, {
            branchId: branchIdForLog,
            actorUserId,
            category: 'pricing',
            action: 'purchase_price_change',
            entityType: 'product',
            entityId: id,
            actionText: `Changed purchase price of ${displayName} from ${formatMoneyLabel(oldBuy, currency)} to ${formatMoneyLabel(newBuy, currency)}.`,
            affectedItem: displayName,
          })
        }
      }

      if ('offerId' in payload) {
        const oldOffer = existing.offerId || null
        const newOffer = payload.offerId || null
        if (oldOffer !== newOffer) {
         const newOfferText = await getOfferLabel(client, newOffer)
         const oldOfferText = await getOfferLabel(client, oldOffer)
          await logProductActivity(client, tenantId, {
            branchId: branchIdForLog,
            actorUserId,
            category: 'pricing',
            action: newOffer ? 'offer_apply' : 'offer_remove',
            actionText: newOffer
        ? `Applied offer${newOfferText} to ${displayName}.`
        : `Removed offer${oldOfferText} from ${displayName}.`,
            entityType: 'product',
            entityId: id,
            affectedItem: displayName,
            details: { offerId: newOffer, previousOfferId: oldOffer },
          })
        }
      }

      // Generic edit when non-price/status fields changed (scale removed from product UX)
      const editedKeys = Object.keys(payload).filter(
        (k) =>
          ![
            'createdBy',
            'branchId',
            'confirmed',
            'variants',
            'bundleItems',
            'quantity',
            'sellingPrice',
            'purchasePrice',
            'offerId',
            'discountPercent',
            'status',
            'taxIds',
            'taxPercent',
            'scale',
          ].includes(k) && payload[k] !== undefined,
      )
      if (editedKeys.length && !becomingInactive) {
        await logProductActivity(client, tenantId, {
          branchId: branchIdForLog,
          actorUserId,
          category: 'products',
          action: 'product_update',
          entityType: 'product',
          entityId: id,
          actionText: `Edited product "${displayName}": ${editedKeys.join(', ')} updated.`,
          affectedItem: displayName,
        })
      }

      // Include synced SKU ids so the client can upload per-variant images
      if (syncedVariants) {
        return { ...product, variants: syncedVariants }
      }
      return product
    })

    if (updated) {
      await notifyCustomVariantCatalog(tenantId, {
        productId: updated.id,
        productName: updated.name,
        createdBy: payload.createdBy,
        catalogAdditions: catalogAdditionsFromMap(catalogMap),
        branchId: payload.branchId || updated.branchId || null,
      })
    }

    return updated
  } catch (err) {
    mapUniqueViolation(err, 'Item code or barcode already exists in this branch')
  }
}

// Drop ledger rows for product + variant SKUs so unused products can hard-delete
async function deleteProductLedgerRows(client, tenantId, productId) {
  await tenantClientQuery(
    client,
    tenantId,
    `
      DELETE FROM inventory_ledger
      WHERE tenant_id = $1
        AND (
          product_id = $2
          OR product_id IN (
            SELECT id FROM products WHERE tenant_id = $1 AND parent_id = $2
          )
        )
    `,
    [productId],
  )
}

export async function permanentDeleteProduct(tenantId, id, { branchId = null } = {}) {
  const eligibility = await getProductDeleteEligibility(tenantId, id, { branchId })
  if (!eligibility.found) return null
  if (!eligibility.canPermanentDelete) {
    throw httpError(409, eligibility.reason || 'Product cannot be permanently deleted')
  }

  return withTransaction(async (client) => {
    await deleteProductLedgerRows(client, tenantId, id)
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM products
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        RETURNING id
      `,
      [id, branchId],
    )
    return Boolean(rows[0])
  })
}

export async function deleteProduct(
  tenantId,
  id,
  { branchId = null, permanent = false, createdBy = null } = {},
) {
  // Soft delete (deactivate) or permanent — dissolve remaining bundle stock first
  if (permanent) {
    const eligibility = await getProductDeleteEligibility(tenantId, id, { branchId })
    if (!eligibility.found) return false
    if (!eligibility.canPermanentDelete) {
      throw httpError(409, eligibility.reason || 'Product cannot be permanently deleted')
    }
  }

  return withTransaction(async (client) => {
    const { rows: existingRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          id, name, type, scale, status, quantity,
          branch_id AS "branchId"
        FROM products
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        LIMIT 1
      `,
      [id, branchId],
    )
    const existing = existingRows[0]
    if (!existing) return false

    if (existing.type === PRODUCT_TYPES.BUNDLE) {
      await disassembleBundleFully(client, tenantId, existing, {
        scopeBranchId: existing.branchId || branchId || null,
      })
    }

    const isBundleType = existing.type === PRODUCT_TYPES.BUNDLE
    const logBranch = existing.branchId || branchId

    if (permanent) {
      // Ledger from opening stock / adjustments must go before product DELETE (no CASCADE)
      await deleteProductLedgerRows(client, tenantId, id)
      const { rows } = await tenantClientQuery(
        client,
        tenantId,
        `
          DELETE FROM products
          WHERE tenant_id = $1 AND id = $2
            ${branchClause('', 3)}
          RETURNING id
        `,
        [id, branchId],
      )
      if (rows[0]) {
        await logProductActivity(client, tenantId, {
          branchId: logBranch,
          actorUserId: createdBy,
          category: isBundleType ? 'bundles' : 'products',
          action: isBundleType ? 'bundle_delete' : 'product_delete',
          entityType: 'product',
          entityId: id,
          actionText: isBundleType
            ? `Deleted bundle "${existing.name}". Remaining units dissolved; stock returned to component items.`
            : `Deleted product "${existing.name}".`,
          affectedItem: existing.name,
        })
      }
      return Boolean(rows[0])
    }

    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE products
        SET status = 'inactive', updated_at = now()
        WHERE tenant_id = $1 AND id = $2
          ${branchClause('', 3)}
        RETURNING id
      `,
      [id, branchId],
    )
    if (rows[0]) {
      await logProductActivity(client, tenantId, {
        branchId: logBranch,
        actorUserId: createdBy,
        category: isBundleType ? 'bundles' : 'products',
        action: isBundleType ? 'bundle_deactivate' : 'product_deactivate',
        entityType: 'product',
        entityId: id,
        actionText: isBundleType
          ? `Deactivated bundle "${existing.name}". Remaining units dissolved; stock returned to component items.`
          : `Deactivated product "${existing.name}".`,
        affectedItem: existing.name,
      })
    }
    return Boolean(rows[0])
  })
}
