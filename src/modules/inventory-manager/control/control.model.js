import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import { CONTROL_SOURCES, MOVEMENT_TYPES, PRODUCT_TYPES } from '../../../config/constants.js'
import {
  applyPriceLayersForMovement,
  shouldKeepExistingStockPrice,
} from './priceLayers.js'
import {
  applyBundleAssembleDelta,
  loadBundleRecipe,
} from '../products/bundleAssemble.js'
import {
  formatStockActionText,
  stockActionFromMovement,
  writeAdminActivity,
} from '../../../utils/adminActivityLog.util.js'
import {
  formatMoneyLabel,
  getTenantCurrencyCode,
} from '../../../utils/currency.util.js'

// products.quantity = on-hand for that branch-scoped product row (IM source of truth).
// branch_inventory = per-branch allocation — must stay in sync when IM adjusts stock
// for their JWT branch (stock-in / stock-out / damaged / expired / other / adjustment).
// Transfers only move qty between branch_inventory rows (on-hand delta = 0).
function onHandDelta(movementType, quantity) {
  const amount = Number(quantity)
  if (movementType === MOVEMENT_TYPES.IN) return amount
  // Adjustment + Others: signed qty (positive increases, negative decreases).
  if (movementType === MOVEMENT_TYPES.ADJUSTMENT || movementType === MOVEMENT_TYPES.OTHER) {
    return amount
  }
  if (movementType === MOVEMENT_TYPES.TRANSFER) return 0
  return -Math.abs(amount)
}

const PRICE_UTILIZATION_MESSAGE =
  'New purchase/selling price applies only after previous stock is fully utilized (on-hand must be 0).'

// Tenant BM setting: block price changes while leftover stock remains.
export async function getPriceUtilizationRule(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT price_requires_stock_utilized AS "priceRequiresStockUtilized"
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [],
  )
  return {
    priceRequiresStockUtilized: Boolean(rows[0]?.priceRequiresStockUtilized),
  }
}

export async function setPriceUtilizationRule(tenantId, enabled) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE tenants
      SET price_requires_stock_utilized = $2
      WHERE id = $1
      RETURNING price_requires_stock_utilized AS "priceRequiresStockUtilized"
    `,
    [Boolean(enabled)],
  )
  return {
    priceRequiresStockUtilized: Boolean(rows[0]?.priceRequiresStockUtilized),
  }
}

export async function assertPriceChangeAllowed(
  client,
  tenantId,
  productId,
  { purchasePrice, sellingPrice } = {},
) {
  const { rows: settingRows } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT price_requires_stock_utilized AS enabled FROM tenants WHERE id = $1 LIMIT 1`,
    [],
  )
  if (!settingRows[0]?.enabled) return

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        quantity,
        purchase_price AS "purchasePrice",
        selling_price AS "sellingPrice"
      FROM products
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
    `,
    [productId],
  )
  const product = rows[0]
  if (!product) throw httpError(404, 'Product not found')

  const onHand = Number(product.quantity) || 0
  if (onHand <= 0) return

  const purchaseChanging =
    purchasePrice != null &&
    Number(purchasePrice) !== Number(product.purchasePrice)
  const sellingChanging =
    sellingPrice != null &&
    Number(sellingPrice) !== Number(product.sellingPrice)

  if (purchaseChanging || sellingChanging) {
    throw httpError(422, PRICE_UTILIZATION_MESSAGE)
  }
}

// Public helper for product PATCH / daily price (own transaction).
export async function assertPriceChangeAllowedForProduct(
  tenantId,
  productId,
  { purchasePrice, sellingPrice } = {},
) {
  return withTransaction((client) =>
    assertPriceChangeAllowed(client, tenantId, productId, { purchasePrice, sellingPrice }),
  )
}

async function applyPurchaseSnapshot(
  client,
  tenantId,
  { productId, supplierId, unitCost, addedQty = 0 },
) {
  if (unitCost == null && !supplierId) return

  // Keep-old: do not overwrite the active purchase price while older units remain.
  let skipPrice = false
  if (unitCost != null && (await shouldKeepExistingStockPrice(client, tenantId))) {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT quantity, purchase_price AS "purchasePrice"
        FROM products
        WHERE tenant_id = $1 AND id = $2
      `,
      [productId],
    )
    const onHand = Number(rows[0]?.quantity) || 0
    const previous = onHand - Number(addedQty || 0)
    if (previous > 0 && Number(unitCost) !== Number(rows[0]?.purchasePrice)) {
      skipPrice = true
    }
  }

  if (skipPrice) {
    if (!supplierId) return
    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE products
        SET current_purchase_supplier_id = $3
        WHERE tenant_id = $1 AND id = $2
      `,
      [productId, supplierId],
    )
    return
  }

  await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE products
      SET
        last_purchase_price = CASE
          WHEN $3::numeric IS NOT NULL AND purchase_price IS DISTINCT FROM $3::numeric THEN purchase_price
          ELSE last_purchase_price
        END,
        last_purchase_supplier_id = CASE
          WHEN $3::numeric IS NOT NULL AND purchase_price IS DISTINCT FROM $3::numeric
            THEN current_purchase_supplier_id
          ELSE last_purchase_supplier_id
        END,
        purchase_price = COALESCE($3::numeric, purchase_price),
        current_purchase_supplier_id = COALESCE($4::uuid, current_purchase_supplier_id)
      WHERE tenant_id = $1 AND id = $2
    `,
    [productId, unitCost ?? null, supplierId || null],
  )
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

const OUTBOUND_TYPES = new Set([MOVEMENT_TYPES.OUT, MOVEMENT_TYPES.DAMAGED, MOVEMENT_TYPES.EXPIRED])

async function assertSufficientStock(client, tenantId, productId, quantity) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        quantity,
        status,
        scale,
        name,
        variant_label AS "variantLabel",
        branch_id AS "branchId"
      FROM products
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
    `,
    [productId],
  )
  if (!rows[0]) throw httpError(404, 'Product not found')
  if (rows[0].status === 'inactive') {
    throw httpError(409, 'Product is inactive and cannot be used for stock movements')
  }
  if (Number(rows[0].quantity) < Number(quantity)) {
    throw httpError(422, 'Insufficient stock on hand')
  }
  return rows[0]
}

async function lockProduct(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        quantity,
        status,
        scale,
        name,
        variant_label AS "variantLabel",
        branch_id AS "branchId"
      FROM products
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
    `,
    [productId],
  )
  if (!rows[0]) throw httpError(404, 'Product not found')
  return rows[0]
}

async function assertProductActive(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT id, status FROM products WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [productId],
  )
  if (!rows[0]) throw httpError(404, 'Product not found')
  if (rows[0].status === 'inactive') {
    throw httpError(409, 'Product is inactive and cannot be used for stock movements')
  }
  return rows[0]
}

async function applyOnHand(client, tenantId, productId, delta) {
  if (!delta) return
  const { rowCount } = await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE products
      SET quantity = quantity + $3
      WHERE tenant_id = $1 AND id = $2 AND quantity + $3 >= 0
    `,
    [productId, delta],
  )
  if (!rowCount) {
    throw httpError(422, 'Insufficient stock on hand')
  }
}

async function assertBranchExists(client, tenantId, branchId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT id FROM branches WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [branchId],
  )
  if (!rows[0]) throw httpError(404, 'Branch not found')
}

async function adjustBranchInventory(
  client,
  tenantId,
  branchId,
  productId,
  delta,
  { optional = false, clamp = false } = {},
) {
  const amount = Number(delta)
  if (!amount) return

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT quantity
      FROM branch_inventory
      WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3
      FOR UPDATE
    `,
    [branchId, productId],
  )

  if (!rows[0]) {
    // POS may run before branch stock is seeded — skip outbound when not tracked
    if (amount < 0) {
      if (optional || clamp) return
      throw httpError(422, 'Insufficient branch stock')
    }
    await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO branch_inventory (tenant_id, branch_id, product_id, quantity)
        VALUES ($1, $2, $3, $4)
      `,
      [branchId, productId, amount],
    )
    return
  }

  const current = Number(rows[0].quantity)
  let next = current + amount
  // IM stock-out is authoritative: never leave orphan branch qty below zero intent
  if (next < 0) {
    if (clamp) next = 0
    else throw httpError(422, 'Insufficient branch stock')
  }

  await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE branch_inventory
      SET quantity = $4, updated_at = now()
      WHERE tenant_id = $1 AND branch_id = $2 AND product_id = $3
    `,
    [branchId, productId, next],
  )
}

function validateQuantityForType(movementType, quantity) {
  const amount = Number(quantity)
  if (Number.isNaN(amount)) throw httpError(422, 'Invalid quantity')
  if (
    movementType === MOVEMENT_TYPES.ADJUSTMENT ||
    movementType === MOVEMENT_TYPES.OTHER
  ) {
    if (amount === 0) {
      throw httpError(
        422,
        movementType === MOVEMENT_TYPES.OTHER
          ? 'Other quantity cannot be zero'
          : 'Adjustment quantity cannot be zero',
      )
    }
    return
  }
  if (OUTBOUND_TYPES.has(movementType) || movementType === MOVEMENT_TYPES.IN) {
    if (!(amount > 0)) throw httpError(422, 'Quantity must be positive')
  }
}

export async function listTransfers(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit

  const filterParams = [
    filters.q || null,
    filters.categoryId || null,
    filters.subcategoryId || null,
    filters.scale || null,
    filters.type || null,
    filters.branchId || null,
  ]

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.movement_type = 'transfer'
        AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.item_code ILIKE '%' || $2 || '%')
        AND ($3::uuid IS NULL OR p.category_id = $3)
        AND ($4::uuid IS NULL OR p.subcategory_id = $4)
        AND ($5::text IS NULL OR p.scale = $5)
        AND ($6::text IS NULL OR p.type = $6)
        AND ($7::uuid IS NULL OR p.branch_id = $7)
    `,
    filterParams,
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        l.id,
        l.quantity,
        l.scale,
        l.reason,
        l.created_at AS "createdAt",
        p.name AS "productName",
        p.item_code AS "itemCode",
        fb.id AS "fromBranchId",
        fb.name AS "fromBranchName",
        tb.id AS "toBranchId",
        tb.name AS "toBranchName"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      JOIN branches fb ON fb.id = l.from_branch_id AND fb.tenant_id = l.tenant_id
      JOIN branches tb ON tb.id = l.to_branch_id AND tb.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.movement_type = 'transfer'
        AND ($2::text IS NULL OR p.name ILIKE '%' || $2 || '%' OR p.item_code ILIKE '%' || $2 || '%')
        AND ($3::uuid IS NULL OR p.category_id = $3)
        AND ($4::uuid IS NULL OR p.subcategory_id = $4)
        AND ($5::text IS NULL OR p.scale = $5)
        AND ($6::text IS NULL OR p.type = $6)
        AND ($7::uuid IS NULL OR p.branch_id = $7)
      ORDER BY l.created_at DESC
      LIMIT $8 OFFSET $9
    `,
    [...filterParams, limit, offset],
  )
  return { items: rows, total: countRows[0]?.total || 0, page, limit }
}

export async function createStockTransfer(tenantId, event) {
  if (event.fromBranchId === event.toBranchId) {
    throw httpError(422, 'Source and destination branches must differ')
  }

  return withTransaction(async (client) => {
    await assertBranchExists(client, tenantId, event.fromBranchId)
    await assertBranchExists(client, tenantId, event.toBranchId)

    // Branch scope: product must belong to scoped branch when set
    const { rows: products } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, status, branch_id AS "branchId"
        FROM products
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        LIMIT 1
      `,
      [event.productId, event.scopeBranchId || null],
    )
    if (!products[0]) throw httpError(404, 'Product not found')
    if (products[0].status === 'inactive') {
      throw httpError(409, 'Product is inactive and cannot be transferred')
    }
    if (event.scopeBranchId && event.fromBranchId !== event.scopeBranchId) {
      throw httpError(403, 'Transfers must originate from your assigned branch')
    }

    await adjustBranchInventory(
      client,
      tenantId,
      event.fromBranchId,
      event.productId,
      -Math.abs(Number(event.quantity)),
    )
    await adjustBranchInventory(
      client,
      tenantId,
      event.toBranchId,
      event.productId,
      Math.abs(Number(event.quantity)),
    )

    return insertLedgerEventInTx(client, tenantId, {
      ...event,
      movementType: MOVEMENT_TYPES.TRANSFER,
    })
  })
}

// Shared WHERE for ledger list — AND logic across all applied filters.
// Variant type/value match child SKU option rows (product_variant_options).
const LEDGER_LIST_WHERE = `
  WHERE l.tenant_id = $1
    AND ($2::text[] IS NULL OR l.movement_type = ANY($2::text[]))
    AND (
      $3::text IS NULL
      OR p.name ILIKE '%' || $3 || '%'
      OR p.item_code ILIKE '%' || $3 || '%'
      OR COALESCE(p.barcode, '') ILIKE '%' || $3 || '%'
    )
    AND ($4::uuid IS NULL OR p.category_id = $4)
    AND ($5::uuid IS NULL OR p.subcategory_id = $5)
    AND ($6::text IS NULL OR p.scale = $6)
    AND ($7::text IS NULL OR p.type = $7)
    AND ($8::uuid IS NULL OR p.branch_id = $8)
    AND ($9::uuid IS NULL OR p.id = $9 OR p.parent_id = $9)
    AND ($10::date IS NULL OR l.created_at::date >= $10::date)
    AND ($11::date IS NULL OR l.created_at::date <= $11::date)
    AND ($12::text IS NULL OR COALESCE(p.variant_label, '') ILIKE '%' || $12 || '%')
    AND (
      $13::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM product_variant_options pvo
        WHERE pvo.tenant_id = l.tenant_id
          AND pvo.product_id = p.id
          AND pvo.variant_type_id = $13
      )
    )
    AND (
      $14::uuid IS NULL
      OR EXISTS (
        SELECT 1
        FROM product_variant_options pvo
        WHERE pvo.tenant_id = l.tenant_id
          AND pvo.product_id = p.id
          AND pvo.variant_value_id = $14
      )
    )
    -- When set (Adjustment tab), only include stock-in rows tagged from Adjustment dialog
    AND ($15::text IS NULL OR l.movement_type <> 'in' OR l.control_source = $15)
`

function ledgerFilterParams(filters = {}, overrides = {}) {
  let types = null
  if (Object.prototype.hasOwnProperty.call(overrides, 'movementTypes')) {
    types = overrides.movementTypes
  } else if (Array.isArray(filters.movementTypes)) {
    types = filters.movementTypes
  } else if (filters.movementType) {
    types = [filters.movementType]
  }

  const from = Object.prototype.hasOwnProperty.call(overrides, 'from')
    ? overrides.from
    : filters.from || null
  const to = Object.prototype.hasOwnProperty.call(overrides, 'to')
    ? overrides.to
    : filters.to || null

  const controlSourceForIn = Object.prototype.hasOwnProperty.call(overrides, 'controlSourceForIn')
    ? overrides.controlSourceForIn
    : filters.controlSourceForIn || null

  return [
    types,
    filters.q || null,
    filters.categoryId || null,
    filters.subcategoryId || null,
    filters.scale || null,
    filters.type || null,
    filters.branchId || null,
    filters.productId || null,
    from,
    to,
    filters.variantLabel || null,
    filters.variantTypeId || null,
    filters.variantValueId || null,
    controlSourceForIn,
  ]
}

// Control summary — KPIs + tab counts for Phase 2 chrome.
export async function getControlSummary(tenantId, filters = {}) {
  const branchId = filters.branchId || null
  const productFilters = [
    filters.q || null,
    filters.categoryId || null,
    filters.subcategoryId || null,
    filters.scale || null,
    filters.type || null,
    branchId,
    filters.productId || null,
    filters.variantLabel || null,
    filters.variantTypeId || null,
    filters.variantValueId || null,
  ]

  const PRODUCT_FILTER_WHERE = `
    WHERE p.tenant_id = $1
      AND p.status = 'active'
      AND NOT (p.type = 'variant' AND p.parent_id IS NULL)
      AND (
        $2::text IS NULL
        OR p.name ILIKE '%' || $2 || '%'
        OR p.item_code ILIKE '%' || $2 || '%'
        OR COALESCE(p.barcode, '') ILIKE '%' || $2 || '%'
      )
      AND ($3::uuid IS NULL OR p.category_id = $3)
      AND ($4::uuid IS NULL OR p.subcategory_id = $4)
      AND ($5::text IS NULL OR p.scale = $5)
      AND ($6::text IS NULL OR p.type = $6)
      AND ($7::uuid IS NULL OR p.branch_id = $7)
      AND ($8::uuid IS NULL OR p.id = $8 OR p.parent_id = $8)
      AND ($9::text IS NULL OR COALESCE(p.variant_label, '') ILIKE '%' || $9 || '%')
      AND (
        $10::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM product_variant_options pvo
          WHERE pvo.tenant_id = p.tenant_id
            AND pvo.product_id = p.id
            AND pvo.variant_type_id = $10
        )
      )
      AND (
        $11::uuid IS NULL
        OR EXISTS (
          SELECT 1
          FROM product_variant_options pvo
          WHERE pvo.tenant_id = p.tenant_id
            AND pvo.product_id = p.id
            AND pvo.variant_value_id = $11
        )
      )
  `

  const { rows: stockRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        COALESCE(sum(p.quantity), 0)::numeric AS "totalStockOnHand",
        count(*)::int AS "productCount",
        count(*) FILTER (WHERE p.quantity <= 0)::int AS "outOfStockCount",
        count(*) FILTER (
          WHERE p.quantity > 0 AND p.quantity <= COALESCE(p.reorder_point, 0)
        )::int AS "lowStockCount"
      FROM products p
      ${PRODUCT_FILTER_WHERE}
    `,
    productFilters,
  )

  const stock = stockRows[0] || {}
  const lowStockCount = Number(stock.lowStockCount) || 0
  const outOfStockCount = Number(stock.outOfStockCount) || 0
  const attentionCount = lowStockCount + outOfStockCount

  // Active alerts: only after at least one stock-in (TL: no alert on zero opening stock).
  const { rows: alertCountRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS "alertCount"
      FROM products p
      ${PRODUCT_FILTER_WHERE}
        AND EXISTS (
          SELECT 1 FROM inventory_ledger l
          WHERE l.tenant_id = p.tenant_id
            AND l.product_id = p.id
            AND l.movement_type = 'in'
        )
        AND (
          p.quantity <= 0
          OR (
            COALESCE(p.reorder_point, 0) > 0
            AND p.quantity > 0
            AND p.quantity <= p.reorder_point
          )
        )
    `,
    productFilters,
  )
  const alertCount = Number(alertCountRows[0]?.alertCount) || 0

  // Today totals — ignore date range filters; respect catalog filters.
  const { rows: todayRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        COALESCE(sum(l.quantity) FILTER (WHERE l.movement_type = 'in'), 0)::numeric AS "stockInToday",
        COALESCE(
          sum(ABS(l.quantity)) FILTER (
            WHERE l.movement_type IN ('out', 'damaged', 'expired', 'other')
          ),
          0
        )::numeric AS "stockOutToday"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.created_at::date = CURRENT_DATE
        AND (
          $2::text IS NULL
          OR p.name ILIKE '%' || $2 || '%'
          OR p.item_code ILIKE '%' || $2 || '%'
          OR COALESCE(p.barcode, '') ILIKE '%' || $2 || '%'
        )
        AND ($3::uuid IS NULL OR p.category_id = $3)
        AND ($4::uuid IS NULL OR p.subcategory_id = $4)
        AND ($5::text IS NULL OR p.scale = $5)
        AND ($6::text IS NULL OR p.type = $6)
        AND ($7::uuid IS NULL OR p.branch_id = $7)
        AND ($8::uuid IS NULL OR p.id = $8 OR p.parent_id = $8)
        AND ($9::text IS NULL OR COALESCE(p.variant_label, '') ILIKE '%' || $9 || '%')
        AND (
          $10::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM product_variant_options pvo
            WHERE pvo.tenant_id = l.tenant_id
              AND pvo.product_id = p.id
              AND pvo.variant_type_id = $10
          )
        )
        AND (
          $11::uuid IS NULL
          OR EXISTS (
            SELECT 1
            FROM product_variant_options pvo
            WHERE pvo.tenant_id = l.tenant_id
              AND pvo.product_id = p.id
              AND pvo.variant_value_id = $11
          )
        )
    `,
    productFilters,
  )

  const today = todayRows[0] || {}

  // Tab counts — same filter set as listLedger (including date range).
  const baseParams = ledgerFilterParams(filters)
  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        count(*) FILTER (WHERE l.movement_type = 'in')::int AS "in",
        count(*) FILTER (WHERE l.movement_type = 'out')::int AS "out",
        count(*) FILTER (WHERE l.movement_type = 'adjustment')::int AS "adjustment",
        count(*) FILTER (WHERE l.movement_type = 'damaged')::int AS "damaged",
        count(*) FILTER (WHERE l.movement_type = 'expired')::int AS "expired",
        count(*) FILTER (WHERE l.movement_type = 'other')::int AS "other",
        count(*) FILTER (
          WHERE l.movement_type = 'in' AND l.control_source = 'adjustment'
        )::int AS "adjustmentStockIn"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      ${LEDGER_LIST_WHERE}
    `,
    baseParams,
  )

  const tabCounts = countRows[0] || {}

  // Products with daily price toggle that still need today's update.
  const { rows: dailyPendingRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS pending
      FROM products p
      ${PRODUCT_FILTER_WHERE}
        AND p.daily_price_change = TRUE
        AND (
          p.daily_price_updated_on IS NULL
          OR p.daily_price_updated_on < CURRENT_DATE
        )
    `,
    productFilters,
  )

  const priceRule = await getPriceUtilizationRule(tenantId)

  return {
    totalStockOnHand: Number(stock.totalStockOnHand) || 0,
    productCount: Number(stock.productCount) || 0,
    stockInToday: Number(today.stockInToday) || 0,
    stockOutToday: Number(today.stockOutToday) || 0,
    attentionCount,
    lowStockCount,
    outOfStockCount,
    alertCount,
    dailyPricePendingCount: Number(dailyPendingRows[0]?.pending) || 0,
    priceRequiresStockUtilized: priceRule.priceRequiresStockUtilized,
    tabCounts: (() => {
      const adjustmentOnly = Number(tabCounts.adjustment) || 0
      const damaged = Number(tabCounts.damaged) || 0
      const expired = Number(tabCounts.expired) || 0
      const other = Number(tabCounts.other) || 0
      const outOnly = Number(tabCounts.out) || 0
      const adjustmentStockIn = Number(tabCounts.adjustmentStockIn) || 0
      return {
        in: Number(tabCounts.in) || 0,
        // Stock Out badge = POS out + Adjustment stock-out reasons
        out: outOnly + damaged + expired + other,
        outOnly,
        // Adjustment tab badge = adjust + out-reasons + tagged stock-in
        adjustment: adjustmentOnly + damaged + expired + other + adjustmentStockIn,
        adjustmentOnly,
        adjustmentStockIn,
        damaged,
        expired,
        other,
      }
    })(),
  }
}

export async function listLedger(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit

  const filterParams = ledgerFilterParams(filters)

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      ${LEDGER_LIST_WHERE}
    `,
    filterParams,
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        l.id,
        l.product_id AS "productId",
        l.movement_type AS "movementType",
        l.quantity,
        l.scale,
        l.reason,
        l.created_at AS "createdAt",
        l.expires_at AS "expiresAt",
        l.supplier_id AS "supplierId",
        l.purchase_order_id AS "purchaseOrderId",
        l.damaged_by_user_id AS "damagedByUserId",
        l.damaged_location AS "damagedLocation",
        l.unit_cost AS "unitCost",
        l.to_branch_id AS "toBranchId",
        l.control_source AS "controlSource",
        p.name AS "productName",
        p.image_url AS "imageUrl",
        p.type AS "productType",
        p.type,
        p.item_code AS "itemCode",
        p.barcode,
        p.parent_id AS "parentId",
        p.variant_label AS "variantLabel",
        cat.name AS "categoryName",
        sub.name AS "subcategoryName",
        s.company_name AS "companyName",
        du.full_name AS "damagedByName"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      LEFT JOIN categories cat ON cat.id = p.category_id AND cat.tenant_id = l.tenant_id
      LEFT JOIN categories sub ON sub.id = p.subcategory_id AND sub.tenant_id = l.tenant_id
      LEFT JOIN suppliers s ON s.id = l.supplier_id AND s.tenant_id = l.tenant_id
      LEFT JOIN users du ON du.id = l.damaged_by_user_id AND du.tenant_id = l.tenant_id
      ${LEDGER_LIST_WHERE}
      ORDER BY l.created_at DESC
      LIMIT $16 OFFSET $17
    `,
    [...filterParams, limit, offset],
  )
  return { items: rows, total: countRows[0]?.total || 0, page, limit }
}

export async function getLedgerById(tenantId, id, client = null, { branchId = null } = {}) {
  const run = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)
  const { rows } = await run(
    `
      SELECT
        l.id,
        l.product_id AS "productId",
        l.movement_type AS "movementType",
        l.quantity,
        l.to_branch_id AS "toBranchId"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.id = $2
        AND ($3::uuid IS NULL OR p.branch_id = $3)
      LIMIT 1
      FOR UPDATE OF l
    `,
    [id, branchId || null],
  )
  return rows[0] || null
}

/**
 * Control Stock In on a bundle must assemble (same as Edit Bundle top-up):
 * deduct recipe components, then IN finished qty.
 * Returns { handled: false } for non-bundles, or { handled: true, row } after assemble.
 */
async function tryAssembleBundleOnStockIn(client, tenantId, event) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        type,
        name,
        scale,
        quantity,
        branch_id AS "branchId"
      FROM products
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
    `,
    [event.productId],
  )
  const product = rows[0]
  // Not a bundle — normal Stock In path continues
  if (!product || product.type !== PRODUCT_TYPES.BUNDLE) {
    return { handled: false }
  }

  const added = Math.abs(Number(event.quantity) || 0)
  if (!(added > 0)) {
    throw httpError(422, 'Bundle stock-in quantity must be greater than zero')
  }

  const recipe = await loadBundleRecipe(client, tenantId, product.id)
  if (!recipe.length) {
    throw httpError(422, 'Bundle has no recipe items and cannot be stocked in')
  }

  const oldQty = Math.max(0, Number(product.quantity) || 0)
  const branchId = event.branchId || event.scopeBranchId || product.branchId || null

  // Reuse Product Management assemble engine (component OUT + bundle IN)
  const row = await applyBundleAssembleDelta(
    client,
    tenantId,
    {
      bundleId: product.id,
      bundleName: product.name,
      bundleScale: event.scale || product.scale || 'unit',
      oldBundleQty: oldQty,
      newBundleQty: oldQty + added,
      oldItems: recipe,
      newItems: recipe,
      createdBy: event.createdBy || null,
      scopeBranchId: event.scopeBranchId || branchId,
      branchId,
      bundleLedgerExtras: {
        supplierId: event.supplierId || null,
        unitCost: event.unitCost ?? null,
        sellingPrice: event.sellingPrice ?? null,
        controlSource: event.controlSource || null,
        purchaseOrderId: event.purchaseOrderId || null,
        toBranchId: event.toBranchId || null,
        actorName: event.actorName,
        actorRole: event.actorRole,
      },
    },
    insertLedgerEventInTx,
  )

  return { handled: true, row }
}

export async function insertLedgerEventInTx(client, tenantId, event) {
  // Bundle Stock In → assemble components first (skip when already inside assemble)
  if (event.movementType === MOVEMENT_TYPES.IN && !event.skipBundleAssemble) {
    const assembled = await tryAssembleBundleOnStockIn(client, tenantId, event)
    if (assembled.handled) return assembled.row
  }

  // Branch scope: when scoped, product must belong to that branch
  if (event.scopeBranchId != null) {
    const { rows: scoped } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, branch_id
        FROM products
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        LIMIT 1
      `,
      [event.productId, event.scopeBranchId],
    )
    if (!scoped[0]) throw httpError(404, 'Product not found')

    if (event.supplierId) {
      const { rows: suppliers } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT id FROM suppliers
          WHERE tenant_id = $1 AND id = $2 AND branch_id = $3
          LIMIT 1
        `,
        [event.supplierId, event.scopeBranchId],
      )
      if (!suppliers[0]) throw httpError(404, 'Supplier not found')
    }
  }

  await assertProductActive(client, tenantId, event.productId)
  validateQuantityForType(event.movementType, event.quantity)

  const qty = Number(event.quantity)
  const outboundQty = Math.abs(qty)

  // Lock product + keep scale for ledger (UI uses variant type/value; scale optional on body).
  let productRow = null
  if (OUTBOUND_TYPES.has(event.movementType)) {
    productRow = await assertSufficientStock(client, tenantId, event.productId, outboundQty)
  } else if (
    (event.movementType === MOVEMENT_TYPES.ADJUSTMENT ||
      event.movementType === MOVEMENT_TYPES.OTHER) &&
    qty < 0
  ) {
    productRow = await assertSufficientStock(client, tenantId, event.productId, outboundQty)
  } else {
    productRow = await lockProduct(client, tenantId, event.productId)
  }

  const scale = String(event.scale || productRow?.scale || 'unit').trim() || 'unit'

  const destinationBranchId = event.toBranchId || event.branchId || null
  if (event.movementType === MOVEMENT_TYPES.IN && destinationBranchId) {
    await assertBranchExists(client, tenantId, destinationBranchId)
  }

  // Keep branch_inventory in sync with on-hand for this branch (IM / POS).
  // IM adjustments clamp so leftover orphan rows cannot block a full stock-out.
  if (event.branchId && OUTBOUND_TYPES.has(event.movementType)) {
    await adjustBranchInventory(client, tenantId, event.branchId, event.productId, -outboundQty, {
      optional: Boolean(event.posEventId),
      clamp: !event.posEventId,
    })
  }
  if (
    event.branchId &&
    (event.movementType === MOVEMENT_TYPES.ADJUSTMENT ||
      event.movementType === MOVEMENT_TYPES.OTHER)
  ) {
    await adjustBranchInventory(client, tenantId, event.branchId, event.productId, qty, {
      optional: qty < 0,
      clamp: qty < 0,
    })
  }
  if (event.branchId && event.movementType === MOVEMENT_TYPES.IN && event.posEventId) {
    await adjustBranchInventory(client, tenantId, event.branchId, event.productId, outboundQty)
  }

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO inventory_ledger (
        tenant_id, product_id, movement_type, quantity, scale, reason,
        damaged_by_user_id, damaged_location, supplier_id, purchase_order_id,
        expires_at, unit_cost, created_by, pos_event_id, from_branch_id, to_branch_id,
        control_source
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id, movement_type AS "movementType", quantity
    `,
    [
      event.productId,
      event.movementType,
      event.quantity,
      scale,
      event.reason || null,
      event.damagedByUserId || null,
      event.damagedLocation || null,
      event.supplierId || null,
      event.purchaseOrderId || null,
      event.expiresAt || null,
      event.unitCost ?? null,
      event.createdBy || null,
      event.posEventId || null,
      event.fromBranchId || null,
      destinationBranchId && event.movementType === MOVEMENT_TYPES.IN && !event.posEventId
        ? destinationBranchId
        : event.toBranchId || null,
      event.controlSource || null,
    ],
  )

  const oldQty = Number(productRow?.quantity) || 0
  const handDelta = onHandDelta(event.movementType, event.quantity)
  await applyOnHand(client, tenantId, event.productId, handDelta)
  await applyPriceLayersForMovement(client, tenantId, {
    productId: event.productId,
    delta: handDelta,
    sellingPrice: event.sellingPrice ?? null,
    purchasePrice: event.unitCost ?? null,
  })

  // Stock-in received at a branch: allocate to branch_inventory (company total already bumped)
  if (event.movementType === MOVEMENT_TYPES.IN && destinationBranchId && !event.posEventId) {
    await adjustBranchInventory(client, tenantId, destinationBranchId, event.productId, Math.abs(qty))
  }

  if (event.movementType === MOVEMENT_TYPES.IN) {
    await applyPurchaseSnapshot(client, tenantId, {
      productId: event.productId,
      supplierId: event.supplierId,
      unitCost: event.unitCost,
      addedQty: Math.abs(qty),
    })
  }

  // Admin Logs — Stock tab (and Order Receival Stock In via purchaseOrderId).
  // Skip POS-origin ledger (posEventId) to avoid double-count with cashier_log / sale sync.
  // Dual-write with Orders & Suppliers: receival also logs order_receival separately (Phase 3).
  if (!event.posEventId && !event.skipActivityLog) {
    const newTotal = oldQty + handDelta
    const branchIdForLog =
      event.branchId || destinationBranchId || productRow?.branchId || null
    const orderRef = event.orderNumber || event.purchaseOrderId || null
    const affected = productRow?.variantLabel
      ? `${productRow.name || 'Product'} (${productRow.variantLabel})`
      : productRow?.name || 'Product'
    await writeAdminActivity(
      tenantId,
      {
        branchId: branchIdForLog,
        actorUserId: event.createdBy || null,
        actorName: event.actorName,
        actorRole: event.actorRole,
        category: 'stock',
        action: stockActionFromMovement(event.movementType),
        entityType: 'product',
        entityId: event.productId,
        actionText: formatStockActionText({
          movementType: event.movementType,
          quantity: event.quantity,
          productName: productRow?.name,
          variantLabel: productRow?.variantLabel,
          newTotal,
          oldQty,
          orderId: event.purchaseOrderId,
          orderNumber: event.orderNumber,
        }),
        affectedItem: affected,
        details: {
          movementType: event.movementType,
          quantity: Number(event.quantity),
          purchaseOrderId: event.purchaseOrderId || null,
          orderNumber: event.orderNumber || null,
          reason: event.reason || null,
        },
      },
      client,
    )
  }

  return rows[0]
}

export async function insertLedgerEvent(tenantId, event) {
  return withTransaction((client) => insertLedgerEventInTx(client, tenantId, event))
}

export async function insertLedgerLines(tenantId, events) {
  return withTransaction(async (client) => {
    const saved = []
    for (const event of events) {
      saved.push(await insertLedgerEventInTx(client, tenantId, event))
    }
    return saved
  })
}

export async function updateLedgerEvent(
  tenantId,
  id,
  payload,
  expectedMovementType = null,
  { branchId = null } = {},
) {
  return withTransaction(async (client) => {
    const existing = await getLedgerById(tenantId, id, client, { branchId })
    if (!existing) return null
    if (expectedMovementType && existing.movementType !== expectedMovementType) {
      return null
    }

    if ('quantity' in payload && payload.quantity != null) {
      validateQuantityForType(existing.movementType, payload.quantity)
    }

    const setClauses = []
    const params = [id]

    if ('quantity' in payload) {
      setClauses.push(`quantity = $${params.length + 2}`)
      params.push(payload.quantity ?? null)
    }

    if ('reason' in payload) {
      setClauses.push(`reason = $${params.length + 2}`)
      params.push(payload.reason ?? null)
    }

    if ('damagedByUserId' in payload) {
      setClauses.push(`damaged_by_user_id = $${params.length + 2}`)
      params.push(payload.damagedByUserId ?? null)
    }

    if ('damagedLocation' in payload) {
      setClauses.push(`damaged_location = $${params.length + 2}`)
      params.push(payload.damagedLocation ?? null)
    }

    if ('expiresAt' in payload) {
      setClauses.push(`expires_at = $${params.length + 2}`)
      params.push(payload.expiresAt ?? null)
    }

    if ('supplierId' in payload) {
      setClauses.push(`supplier_id = $${params.length + 2}`)
      params.push(payload.supplierId ?? null)
    }

    if (!setClauses.length) {
      const { rows } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT
            id, quantity, reason, product_id AS "productId", movement_type AS "movementType",
            damaged_by_user_id AS "damagedByUserId", damaged_location AS "damagedLocation",
            expires_at AS "expiresAt", supplier_id AS "supplierId", to_branch_id AS "toBranchId"
          FROM inventory_ledger
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        [id],
      )
      return rows[0] || null
    }

    const nextQuantity = 'quantity' in payload ? payload.quantity : existing.quantity
    const delta =
      onHandDelta(existing.movementType, nextQuantity) -
      onHandDelta(existing.movementType, existing.quantity)

    await lockProduct(client, tenantId, existing.productId)
    if (delta < 0) {
      await assertSufficientStock(client, tenantId, existing.productId, Math.abs(delta))
    }

    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE inventory_ledger
        SET ${setClauses.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING
          id, quantity, reason, product_id AS "productId", movement_type AS "movementType",
          damaged_by_user_id AS "damagedByUserId", damaged_location AS "damagedLocation",
          expires_at AS "expiresAt", supplier_id AS "supplierId", to_branch_id AS "toBranchId"
      `,
      params,
    )
    const updated = rows[0]
    await applyOnHand(client, tenantId, existing.productId, delta)
    await applyPriceLayersForMovement(client, tenantId, {
      productId: existing.productId,
      delta,
    })

    // Reverse/apply branch allocation when stock-in was received at a branch
    if (existing.toBranchId && 'quantity' in payload) {
      const branchDelta = Math.abs(Number(nextQuantity)) - Math.abs(Number(existing.quantity))
      if (branchDelta) {
        await adjustBranchInventory(
          client,
          tenantId,
          existing.toBranchId,
          existing.productId,
          branchDelta,
        )
      }
    }

    return updated
  })
}

// reverseOnHand false drops the log only. On-hand stays until a new adjustment.
export async function deleteLedgerEvent(
  tenantId,
  id,
  expectedMovementType = null,
  { branchId = null, reverseOnHand = true } = {},
) {
  return withTransaction(async (client) => {
    const existing = await getLedgerById(tenantId, id, client, { branchId })
    if (!existing) return false
    if (expectedMovementType && existing.movementType !== expectedMovementType) {
      return false
    }

    const reverseDelta = reverseOnHand
      ? -onHandDelta(existing.movementType, existing.quantity)
      : 0

    if (reverseOnHand) {
      await lockProduct(client, tenantId, existing.productId)
      if (reverseDelta < 0) {
        await assertSufficientStock(client, tenantId, existing.productId, Math.abs(reverseDelta))
      }
    }

    const { rowCount } = await tenantClientQuery(
      client,
      tenantId,
      `DELETE FROM inventory_ledger WHERE tenant_id = $1 AND id = $2`,
      [id],
    )
    if (rowCount > 0 && reverseOnHand) {
      await applyOnHand(client, tenantId, existing.productId, reverseDelta)
      await applyPriceLayersForMovement(client, tenantId, {
        productId: existing.productId,
        delta: reverseDelta,
      })
      if (existing.toBranchId && existing.movementType === MOVEMENT_TYPES.IN) {
        await adjustBranchInventory(
          client,
          tenantId,
          existing.toBranchId,
          existing.productId,
          -Math.abs(Number(existing.quantity)),
        )
      }
    }
    return rowCount > 0
  })
}

// Legacy safety for old lots with expires_at — new UX records expired manually via Adjustment.
// Caps qty by current on-hand so prior sales don't fail the batch.
export async function processDueExpirations(tenantId, createdBy = null, { branchId = null } = {}) {
  return withTransaction(async (client) => {
    const { rows: due } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          l.id,
          l.product_id AS "productId",
          l.quantity,
          l.scale,
          l.supplier_id AS "supplierId",
          l.expires_at AS "expiresAt"
        FROM inventory_ledger l
        JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1
          AND l.movement_type = 'in'
          AND l.expires_at IS NOT NULL
          AND l.expires_at::date <= CURRENT_DATE
          AND l.expiry_processed = FALSE
          AND ($2::uuid IS NULL OR p.branch_id = $2)
        ORDER BY l.expires_at ASC, l.created_at ASC
        FOR UPDATE OF l
      `,
      [branchId || null],
    )

    let processed = 0
    for (const row of due) {
      const product = await lockProduct(client, tenantId, row.productId)
      const onHand = Number(product.quantity)
      const lotQty = Math.abs(Number(row.quantity))
      const expireQty = Math.min(lotQty, Math.max(0, onHand))

      if (expireQty > 0) {
        await insertLedgerEventInTx(client, tenantId, {
          productId: row.productId,
          movementType: MOVEMENT_TYPES.EXPIRED,
          quantity: expireQty,
          scale: row.scale || 'unit',
          supplierId: row.supplierId || null,
          expiresAt: row.expiresAt,
          reason: 'Auto-expired from stock-in lot',
          createdBy,
        })
        processed += 1
      }

      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE inventory_ledger
          SET expiry_processed = TRUE
          WHERE tenant_id = $1 AND id = $2
        `,
        [row.id],
      )
    }

    return { processed, scanned: due.length }
  })
}

const SELLABLE_PRODUCT_WHERE = `
  WHERE p.tenant_id = $1
    AND p.status = 'active'
    AND NOT (p.type = 'variant' AND p.parent_id IS NULL)
    AND ($2::uuid IS NULL OR p.branch_id = $2)
`

function stockStatus(quantity, reorderPoint) {
  const qty = Number(quantity) || 0
  const threshold = Number(reorderPoint) || 0
  if (qty <= 0) return 'out'
  if (threshold > 0 && qty <= threshold) return 'low'
  return 'in'
}

// Phase 4 — daily price pending rows (only products with dailyPriceChange enabled).
export async function listDailyPricePending(tenantId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id,
        p.name,
        p.image_url AS "imageUrl",
        p.item_code AS "itemCode",
        p.scale,
        p.variant_label AS "variantLabel",
        p.type AS "productType",
        p.purchase_price AS "purchasePrice",
        p.selling_price AS "sellingPrice",
        p.daily_price_updated_on AS "dailyPriceUpdatedOn",
        cat.name AS "categoryName",
        sub.name AS "subcategoryName"
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id AND cat.tenant_id = p.tenant_id
      LEFT JOIN categories sub ON sub.id = p.subcategory_id AND sub.tenant_id = p.tenant_id
      ${SELLABLE_PRODUCT_WHERE}
        AND p.daily_price_change = TRUE
        AND (
          p.daily_price_updated_on IS NULL
          OR p.daily_price_updated_on < CURRENT_DATE
        )
      ORDER BY p.name ASC
      LIMIT 200
    `,
    [branchId || null],
  )
  return rows
}

export async function updateDailyPrice(
  tenantId,
  productId,
  { purchasePrice, sellingPrice, branchId = null, createdBy = null } = {},
) {
  return withTransaction(async (client) => {
    await assertPriceChangeAllowed(client, tenantId, productId, {
      purchasePrice,
      sellingPrice,
    })

    const { rows: beforeRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          purchase_price AS "purchasePrice",
          selling_price AS "sellingPrice",
          name,
          branch_id AS "branchId",
          variant_label AS "variantLabel"
        FROM products
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        LIMIT 1
      `,
      [productId, branchId || null],
    )
    const before = beforeRows[0]

    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE products
        SET
          last_selling_price = CASE
            WHEN $4::numeric IS NOT NULL AND selling_price IS DISTINCT FROM $4::numeric
              THEN selling_price
            ELSE last_selling_price
          END,
          purchase_price = COALESCE($3::numeric, purchase_price),
          selling_price = COALESCE($4::numeric, selling_price),
          daily_price_updated_on = CURRENT_DATE,
          updated_at = now()
        WHERE tenant_id = $1
          AND id = $2
          AND daily_price_change = TRUE
          AND status = 'active'
          AND ($5::uuid IS NULL OR branch_id = $5)
        RETURNING
          id,
          name,
          purchase_price AS "purchasePrice",
          selling_price AS "sellingPrice",
          daily_price_updated_on AS "dailyPriceUpdatedOn",
          branch_id AS "branchId",
          variant_label AS "variantLabel"
      `,
      [productId, purchasePrice ?? null, sellingPrice ?? null, branchId || null],
    )
    const row = rows[0] || null
    if (row && before) {
      const label = row.variantLabel ? `${row.name} (${row.variantLabel})` : row.name
      const currency = await getTenantCurrencyCode(tenantId)
      if (
        sellingPrice != null &&
        Number(before.sellingPrice) !== Number(row.sellingPrice)
      ) {
        await writeAdminActivity(
          tenantId,
          {
            branchId: row.branchId || branchId,
            actorUserId: createdBy,
            category: 'pricing',
            action: 'daily_price_change',
            entityType: 'product',
            entityId: productId,
            actionText: `Changed selling price of ${label} from ${formatMoneyLabel(before.sellingPrice, currency)} to ${formatMoneyLabel(row.sellingPrice, currency)}.`,
            affectedItem: label,
          },
          client,
        )
      }
      if (
        purchasePrice != null &&
        Number(before.purchasePrice) !== Number(row.purchasePrice)
      ) {
        await writeAdminActivity(
          tenantId,
          {
            branchId: row.branchId || branchId,
            actorUserId: createdBy,
            category: 'pricing',
            action: 'purchase_price_change',
            entityType: 'product',
            entityId: productId,
            actionText: `Changed purchase price of ${label} from ${formatMoneyLabel(before.purchasePrice, currency)} to ${formatMoneyLabel(row.purchasePrice, currency)}.`,
            affectedItem: label,
          },
          client,
        )
      }
    }
    return row
  })
}

// Phase 4 — Manage Thresholds list (all sellable SKUs).
export async function listThresholds(tenantId, { branchId = null, q = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id,
        p.name,
        p.image_url AS "imageUrl",
        p.item_code AS "itemCode",
        p.scale,
        p.variant_label AS "variantLabel",
        p.type AS "productType",
        p.quantity,
        p.reorder_point AS "reorderPoint",
        cat.name AS "categoryName",
        sub.name AS "subcategoryName"
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id AND cat.tenant_id = p.tenant_id
      LEFT JOIN categories sub ON sub.id = p.subcategory_id AND sub.tenant_id = p.tenant_id
      ${SELLABLE_PRODUCT_WHERE}
        AND (
          $3::text IS NULL
          OR p.name ILIKE '%' || $3 || '%'
          OR p.item_code ILIKE '%' || $3 || '%'
        )
      ORDER BY p.name ASC
      LIMIT 300
    `,
    [branchId || null, q || null],
  )
  return rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity) || 0,
    reorderPoint: Number(row.reorderPoint) || 0,
    stockStatus: stockStatus(row.quantity, row.reorderPoint),
  }))
}

export async function upsertThreshold(
  tenantId,
  productId,
  reorderPoint,
  { branchId = null } = {},
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE products
      SET reorder_point = $3::numeric, updated_at = now()
      WHERE tenant_id = $1
        AND id = $2
        AND status = 'active'
        AND ($4::uuid IS NULL OR branch_id = $4)
      RETURNING
        id,
        name,
        quantity,
        reorder_point AS "reorderPoint"
    `,
    [productId, reorderPoint, branchId || null],
  )
  if (!rows[0]) return null
  return {
    ...rows[0],
    quantity: Number(rows[0].quantity) || 0,
    reorderPoint: Number(rows[0].reorderPoint) || 0,
    stockStatus: stockStatus(rows[0].quantity, rows[0].reorderPoint),
  }
}

// Remove threshold monitoring — reorder_point 0 disables low-stock alerts.
export async function clearThreshold(tenantId, productId, { branchId = null } = {}) {
  return upsertThreshold(tenantId, productId, 0, { branchId })
}

// Phase 4 — active low / out-of-stock alerts (only after stock was ever received).
export async function listControlAlerts(tenantId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id,
        p.name,
        p.image_url AS "imageUrl",
        p.item_code AS "itemCode",
        p.scale,
        p.variant_label AS "variantLabel",
        p.type AS "productType",
        p.quantity,
        p.reorder_point AS "reorderPoint",
        cat.name AS "categoryName",
        sub.name AS "subcategoryName"
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id AND cat.tenant_id = p.tenant_id
      LEFT JOIN categories sub ON sub.id = p.subcategory_id AND sub.tenant_id = p.tenant_id
      ${SELLABLE_PRODUCT_WHERE}
        AND EXISTS (
          SELECT 1
          FROM inventory_ledger l
          WHERE l.tenant_id = p.tenant_id
            AND l.product_id = p.id
            AND l.movement_type = 'in'
        )
        AND (
          p.quantity <= 0
          OR (
            p.reorder_point > 0
            AND p.quantity > 0
            AND p.quantity <= p.reorder_point
          )
        )
      ORDER BY
        CASE WHEN p.quantity <= 0 THEN 0 ELSE 1 END,
        p.quantity ASC,
        p.name ASC
      LIMIT 200
    `,
    [branchId || null],
  )
  return rows.map((row) => ({
    ...row,
    quantity: Number(row.quantity) || 0,
    reorderPoint: Number(row.reorderPoint) || 0,
    stockStatus: stockStatus(row.quantity, row.reorderPoint),
  }))
}

// Phase 5 — Export ledger rows for active Control tab + filters.
export async function exportLedgerRows(tenantId, filters = {}) {
  const filterParams = ledgerFilterParams(filters)
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        l.id,
        l.movement_type                          AS "movementType",
        l.quantity,
        l.scale,
        l.reason,
        l.control_source                         AS "controlSource",
        l.created_at                             AS "createdAt",
        p.last_purchase_price                    AS "oldPurchasePrice",
        l.unit_cost                              AS "newPurchasePrice",
        p.last_selling_price                     AS "oldSellingPrice",
        p.selling_price                          AS "newSellingPrice",
        p.item_code                              AS "itemCode",
        p.barcode,
        p.name                                   AS "productName",
        p.type                                   AS "productType",
        p.variant_label                          AS "variantLabel",
        cat.name                                 AS "categoryName",
        sub.name                                 AS "subcategoryName",
        s.company_name                           AS "supplierName"
      FROM inventory_ledger l
      JOIN products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
      LEFT JOIN categories cat ON cat.id = p.category_id    AND cat.tenant_id = l.tenant_id
      LEFT JOIN categories sub ON sub.id = p.subcategory_id AND sub.tenant_id = l.tenant_id
      LEFT JOIN suppliers  s   ON s.id  = l.supplier_id     AND s.tenant_id   = l.tenant_id
      ${LEDGER_LIST_WHERE}
      ORDER BY l.created_at DESC
      LIMIT 5000
    `,
    filterParams,
  )
  return rows
}

async function resolveProductForImport(client, tenantId, row, { branchId = null } = {}) {
  const itemCode = String(row.itemCode || '').trim()
  const barcode = String(row.barcode || '').trim()
  const variantType = String(row.variantType || '').trim()
  const variantValue = String(row.variantValue || '').trim()
  const variantLabel =
    String(row.variantLabel || '').trim() ||
    (variantType && variantValue ? `${variantType}:${variantValue}` : '') ||
    (variantValue || '')

  if (!itemCode && !barcode) {
    throw httpError(422, 'itemCode or barcode is required')
  }

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        name,
        scale,
        quantity,
        status,
        variant_label AS "variantLabel"
      FROM products
      WHERE tenant_id = $1
        AND status = 'active'
        AND NOT (type = 'variant' AND parent_id IS NULL)
        AND ($2::uuid IS NULL OR branch_id = $2)
        AND (
          ($3::text IS NOT NULL AND lower(item_code) = lower($3))
          OR ($4::text IS NOT NULL AND barcode = $4)
        )
        AND (
          $5::text IS NULL
          OR COALESCE(variant_label, '') ILIKE '%' || $5 || '%'
        )
      ORDER BY
        CASE WHEN $3::text IS NOT NULL AND lower(item_code) = lower($3) THEN 0 ELSE 1 END,
        created_at ASC
      LIMIT 5
    `,
    [branchId || null, itemCode || null, barcode || null, variantLabel || null],
  )

  if (!rows.length) throw httpError(422, 'Product not found for itemCode/barcode')
  if (rows.length > 1 && variantLabel) {
    const exact = rows.find(
      (r) => String(r.variantLabel || '').toLowerCase() === variantLabel.toLowerCase(),
    )
    if (exact) return exact
  }
  if (rows.length > 1) {
    throw httpError(422, 'Multiple products matched — set Variant Type/Value to disambiguate')
  }
  return rows[0]
}

// Phase 5 — Import movement rows for one Control tab (valid rows applied; errors reported).
export async function importControlMovements(
  tenantId,
  { movementType, rows = [], createdBy = null, branchId = null } = {},
) {
  const allowed = new Set([
    MOVEMENT_TYPES.IN,
    MOVEMENT_TYPES.ADJUSTMENT,
    MOVEMENT_TYPES.DAMAGED,
    MOVEMENT_TYPES.OTHER,
  ])
  if (!allowed.has(movementType)) {
    throw httpError(422, 'Import is not supported for this tab')
  }

  const results = { imported: 0, failed: 0, errors: [] }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {}
    const rowNum = i + 2
    try {
      await withTransaction(async (client) => {
        const product = await resolveProductForImport(client, tenantId, row, { branchId })
        const quantity = Number(row.quantity)
        if (!Number.isFinite(quantity) || quantity === 0) {
          throw httpError(422, 'quantity is required and cannot be zero')
        }
        const scale = String(row.scale || product.scale || 'unit').trim() || 'unit'
        const reason = String(row.reason || row.notes || '').trim()

        if (
          movementType === MOVEMENT_TYPES.ADJUSTMENT ||
          movementType === MOVEMENT_TYPES.DAMAGED ||
          movementType === MOVEMENT_TYPES.OTHER
        ) {
          if (reason.length < 3) throw httpError(422, 'reason is required (min 3 characters)')
        }

        const event = {
          productId: product.id,
          movementType,
          quantity:
            movementType === MOVEMENT_TYPES.IN || movementType === MOVEMENT_TYPES.DAMAGED
              ? Math.abs(quantity)
              : quantity,
          scale,
          reason: reason || null,
          createdBy,
          scopeBranchId: branchId,
          // Always sync branch_inventory for scoped import (in + out / damaged / other)
          branchId,
          controlSource:
            movementType === MOVEMENT_TYPES.IN ||
            movementType === MOVEMENT_TYPES.DAMAGED ||
            movementType === MOVEMENT_TYPES.EXPIRED ||
            movementType === MOVEMENT_TYPES.OTHER ||
            movementType === MOVEMENT_TYPES.ADJUSTMENT
              ? CONTROL_SOURCES.ADJUSTMENT
              : null,
          unitCost:
            row.unitCost != null && row.unitCost !== ''
              ? Math.round(Number(row.unitCost))
              : undefined,
          damagedLocation: row.damagedLocation || undefined,
        }

        if (movementType === MOVEMENT_TYPES.DAMAGED) {
          if (!event.damagedLocation) {
            throw httpError(422, 'damagedLocation is required for damaged import')
          }
          const email = String(row.damagedByEmail || '').trim()
          if (!email) throw httpError(422, 'damagedByEmail is required for damaged import')
          const { rows: users } = await tenantClientQuery(
            client,
            tenantId,
            `
              SELECT id FROM users
              WHERE tenant_id = $1 AND lower(email) = lower($2)
              LIMIT 1
            `,
            [email],
          )
          if (!users[0]) throw httpError(422, `User not found for damagedByEmail: ${email}`)
          event.damagedByUserId = users[0].id
        }

        await insertLedgerEventInTx(client, tenantId, event)
      })
      results.imported += 1
    } catch (err) {
      results.failed += 1
      results.errors.push({
        row: rowNum,
        error: err?.message || 'Import failed',
      })
    }
  }

  return results
}

