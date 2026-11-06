import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import {
  MOVEMENT_TYPES,
  PURCHASE_ORDER_EVENT_TYPES,
  PURCHASE_ORDER_STATUS,
} from '../../../config/constants.js'
import { insertLedgerEventInTx } from '../control/control.model.js'
import { buildPurchaseOrderSms, sendSms } from '../../../utils/sms.util.js'
import { createInvoicesForApprovedOrder } from './purchase_order_invoice.model.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// Parent: companies[] — Child: lines per company (legacy supplierId+lines normalized here)
function normalizeCompanies(payload) {
  if (Array.isArray(payload.companies) && payload.companies.length) {
    return payload.companies.map((block) => ({
      supplierId: block.supplierId,
      lines: Array.isArray(block.lines) ? block.lines : [],
    }))
  }
  if (payload.supplierId) {
    return [
      {
        supplierId: payload.supplierId,
        lines: Array.isArray(payload.lines) ? payload.lines : [],
      },
    ]
  }
  return []
}

/**
 * Append-only PO timeline + Admin Logs dual-write.
 * purchase_order_events = IM/BM order page; activity_logs = company audit (Orders & Suppliers tab).
 * Stock In from receival is logged separately via insertLedgerEventInTx (Stock tab + §5.9.3).
 */
async function insertOrderEvent(client, tenantId, { purchaseOrderId, eventType, actorId, payload = {} }) {
  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO purchase_order_events (
        tenant_id, purchase_order_id, event_type, actor_id, payload
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [purchaseOrderId, eventType, actorId || null, JSON.stringify(payload || {})],
  )

  const { rows: orderRows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        order_number AS "orderNumber",
        branch_id AS "branchId"
      FROM purchase_orders
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [purchaseOrderId],
  )
  const order = orderRows[0]
  if (!order?.branchId) return

  const orderRef = order.orderNumber || purchaseOrderId
  let action = 'order_edit'
  let actionText = `Updated order ${orderRef}.`
  // Snapshot status after this event — powers Admin Logs Order Status filter (§3.2)
  let orderStatus = payload.orderStatus || null

  switch (eventType) {
    case PURCHASE_ORDER_EVENT_TYPES.CREATED:
      action = 'order_generate'
      orderStatus = PURCHASE_ORDER_STATUS.PENDING
      actionText = `Submitted order request ${orderRef} with ${payload.itemsNumber ?? '—'} items from ${payload.companiesNumber ?? '—'} supplier(s). Status → Pending.`
      break
    case PURCHASE_ORDER_EVENT_TYPES.EDITED_BY_BM:
      if (payload.action === 'cancelled') {
        action = 'order_cancel'
        orderStatus = PURCHASE_ORDER_STATUS.CANCELLED
        actionText = `Cancelled order ${orderRef}.`
      } else {
        action = 'order_edit'
        orderStatus = PURCHASE_ORDER_STATUS.PENDING
        actionText = `Edited order ${orderRef} before approval: ${payload.companiesNumber ?? '—'} companies / ${payload.itemsNumber ?? '—'} items.`
      }
      break
    case PURCHASE_ORDER_EVENT_TYPES.APPROVED:
      action = 'order_approve'
      orderStatus = PURCHASE_ORDER_STATUS.APPROVED
      actionText = `Approved order ${orderRef}.`
      break
    case PURCHASE_ORDER_EVENT_TYPES.REJECTED:
      action = 'order_reject'
      orderStatus = PURCHASE_ORDER_STATUS.REJECTED
      actionText = `Rejected order ${orderRef}. Notes: "${payload.rejectionNotes || '—'}".`
      break
    case PURCHASE_ORDER_EVENT_TYPES.RECEIVAL_RECORDED:
      action = 'order_receival'
      orderStatus = payload.orderStatus || PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED
      actionText =
        orderStatus === PURCHASE_ORDER_STATUS.RECEIVED
          ? `Recorded final receival on ${orderRef}: ${payload.lineCount ?? '—'} line(s), ${payload.totalUnits ?? '—'} units stocked in. All quantities received — Status → Received.`
          : `Recorded receival round on ${orderRef}: ${payload.lineCount ?? '—'} line(s), ${payload.totalUnits ?? '—'} units stocked in. Status → Partially Received.`
      break
    case PURCHASE_ORDER_EVENT_TYPES.COMPLETED:
      action = 'order_complete'
      orderStatus = PURCHASE_ORDER_STATUS.RECEIVED
      actionText = `Marked order ${orderRef} complete. Status → Received.`
      break
    default:
      break
  }

  await writeAdminActivity(
    tenantId,
    {
      branchId: order.branchId,
      actorUserId: actorId,
      category: 'orders_suppliers',
      action,
      entityType: 'purchase_order',
      entityId: purchaseOrderId,
      actionText,
      affectedItem: orderRef,
      details: {
        eventType,
        orderNumber: order.orderNumber || null,
        orderStatus,
        ...payload,
      },
    },
    client,
  )

  // Invoice generate on approve (§5.9.2)
  if (
    eventType === PURCHASE_ORDER_EVENT_TYPES.APPROVED &&
    Array.isArray(payload.invoiceNumbers) &&
    payload.invoiceNumbers.length
  ) {
    for (const inv of payload.invoiceNumbers.filter(Boolean)) {
      await writeAdminActivity(
        tenantId,
        {
          branchId: order.branchId,
          actorUserId: actorId,
          source: 'system',
          category: 'orders_suppliers',
          action: 'invoice_generate',
          entityType: 'purchase_order_invoice',
          entityId: purchaseOrderId,
          actionText: `Generated invoice ${inv} on order ${orderRef}.`,
          affectedItem: inv,
        },
        client,
      )
    }
  }
}

async function assertActiveSuppliers(client, tenantId, supplierIds, branchId) {
  const uniqueIds = [...new Set(supplierIds.filter(Boolean))]
  if (!uniqueIds.length) throw httpError(422, 'At least one supplier company is required')

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, is_active AS "isActive", company_name AS "companyName"
      FROM suppliers
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND branch_id = $3
    `,
    [uniqueIds, branchId],
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) throw httpError(404, `Supplier not found: ${id}`)
    if (!row.isActive) {
      throw httpError(409, `Supplier "${row.companyName}" is blocked and cannot be used for new orders`)
    }
  }
  return byId
}

async function assertOrderableProducts(client, tenantId, productIds, branchId) {
  const uniqueIds = [...new Set(productIds.filter(Boolean))]
  if (!uniqueIds.length) throw httpError(422, 'At least one order line is required')

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        name,
        type,
        status,
        purchase_price AS "purchasePrice",
        last_purchase_price AS "lastPurchasePrice",
        scale
      FROM products
      WHERE tenant_id = $1
        AND id = ANY($2::uuid[])
        AND branch_id = $3
    `,
    [uniqueIds, branchId],
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of uniqueIds) {
    const row = byId.get(id)
    if (!row) throw httpError(404, `Product not found: ${id}`)
    if (row.type === 'bundle') {
      throw httpError(422, `Bundles are excluded from order requests (${row.name})`)
    }
    if (row.type === 'variant') {
      throw httpError(422, `Select a specific variant combination, not the parent variant product (${row.name})`)
    }
    if (row.status === 'inactive') {
      throw httpError(409, `Cannot add inactive product: ${row.name}`)
    }
  }
  return byId
}

function validateCompanyBlocks(companies) {
  if (!companies.length) throw httpError(422, 'At least one supplier company is required')

  const seenSuppliers = new Set()
  let totalLines = 0

  for (const block of companies) {
    if (!block.supplierId) throw httpError(422, 'Each company block requires a supplier')
    if (seenSuppliers.has(block.supplierId)) {
      throw httpError(422, 'The same supplier cannot appear twice in one order — merge into one company block')
    }
    seenSuppliers.add(block.supplierId)

    const lines = block.lines || []
    if (!lines.length) throw httpError(422, 'Each company block must include at least one item')

    const seenProducts = new Set()
    for (const line of lines) {
      if (!line.productId) throw httpError(422, 'Each line requires a product')
      if (seenProducts.has(line.productId)) {
        throw httpError(422, 'The same item cannot be added twice under the same company — increase quantity instead')
      }
      seenProducts.add(line.productId)
      const qty = Number(line.quantity)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw httpError(422, 'Required quantity must be greater than 0')
      }
    }
    totalLines += lines.length
  }

  return { companyCount: companies.length, itemCount: totalLines }
}

async function replaceOrderCompaniesAndLines(client, tenantId, orderId, companies, productsById) {
  await tenantClientQuery(
    client,
    tenantId,
    `DELETE FROM purchase_order_items WHERE tenant_id = $1 AND purchase_order_id = $2`,
    [orderId],
  )
  await tenantClientQuery(
    client,
    tenantId,
    `DELETE FROM purchase_order_suppliers WHERE tenant_id = $1 AND purchase_order_id = $2`,
    [orderId],
  )

  let sortOrder = 0
  for (const block of companies) {
    await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO purchase_order_suppliers (
          tenant_id, purchase_order_id, supplier_id, sort_order
        )
        VALUES ($1, $2, $3, $4)
      `,
      [orderId, block.supplierId, sortOrder],
    )
    sortOrder += 1

    for (const line of block.lines) {
      const product = productsById.get(line.productId)
      const lastPurchase = product?.lastPurchasePrice ?? product?.purchasePrice ?? 0
      const unitCost =
        line.unitCost !== undefined && line.unitCost !== null && line.unitCost !== ''
          ? Number(line.unitCost)
          : Number(lastPurchase) || 0
      const scale = line.scale || product?.scale || 'unit'

      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO purchase_order_items (
            tenant_id, purchase_order_id, supplier_id, product_id,
            scale, quantity, unit_cost, last_purchase_price, received_quantity
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)
        `,
        [
          orderId,
          block.supplierId,
          line.productId,
          scale,
          Number(line.quantity),
          unitCost,
          lastPurchase,
        ],
      )
    }
  }
}

export async function listPurchaseOrders(
  tenantId,
  { q, supplierId, status, page = 1, limit = 8, branchId = null } = {},
) {
  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 8))
  const offset = (safePage - 1) * safeLimit

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        po.id,
        po.order_number AS "orderNumber",
        po.status,
        po.explanation,
        po.created_at AS "createdAt",
        po.branch_id AS "branchId",
        po.created_by AS "createdBy",
        creator.full_name AS "createdByName",
        po.approved_by AS "approvedBy",
        po.approved_at AS "approvedAt",
        po.rejected_by AS "rejectedBy",
        po.rejected_at AS "rejectedAt",
        po.rejection_notes AS "rejectionNotes",
        po.received_at AS "receivedAt",
        COALESCE(s.company_name, 'Multi-supplier') AS "companyName",
        s.representative_name AS "representativeName",
        s.representative_phone AS "representativePhone",
        (
          SELECT count(*)::int
          FROM purchase_order_suppliers pos
          WHERE pos.tenant_id = po.tenant_id AND pos.purchase_order_id = po.id
        ) AS "companiesNumber",
        (
          SELECT count(*)::int
          FROM purchase_order_items poi
          WHERE poi.tenant_id = po.tenant_id AND poi.purchase_order_id = po.id
        ) AS "itemsNumber",
        EXISTS (
          SELECT 1
          FROM purchase_order_items poi
          WHERE poi.tenant_id = po.tenant_id
            AND poi.purchase_order_id = po.id
            AND poi.received_quantity < poi.quantity
        ) AS "hasRemainingQuantity",
        count(*) OVER()::int AS "_total"
      FROM purchase_orders po
      LEFT JOIN users creator
        ON creator.id = po.created_by AND creator.tenant_id = po.tenant_id
      LEFT JOIN LATERAL (
        SELECT pos.supplier_id
        FROM purchase_order_suppliers pos
        WHERE pos.tenant_id = po.tenant_id AND pos.purchase_order_id = po.id
        ORDER BY pos.sort_order ASC, pos.created_at ASC
        LIMIT 1
      ) first_pos ON true
      LEFT JOIN suppliers s
        ON s.id = COALESCE(first_pos.supplier_id, po.supplier_id)
       AND s.tenant_id = po.tenant_id
      WHERE po.tenant_id = $1
        AND (
          $2::text IS NULL
          OR po.order_number ILIKE '%' || $2 || '%'
          OR s.company_name ILIKE '%' || $2 || '%'
          OR creator.full_name ILIKE '%' || $2 || '%'
        )
        AND (
          $3::uuid IS NULL
          OR po.supplier_id = $3
          OR EXISTS (
            SELECT 1 FROM purchase_order_suppliers pos2
            WHERE pos2.tenant_id = po.tenant_id
              AND pos2.purchase_order_id = po.id
              AND pos2.supplier_id = $3
          )
        )
        AND ($4::text IS NULL OR po.status = $4)
        AND ($5::uuid IS NULL OR po.branch_id = $5)
      ORDER BY po.created_at DESC
      LIMIT $6 OFFSET $7
    `,
    [q || null, supplierId || null, status || null, branchId || null, safeLimit, offset],
  )

  const total = rows[0]?._total || 0
  const items = rows.map(({ _total, ...item }) => item)
  return { items, total, page: safePage, limit: safeLimit }
}

export async function getPurchaseOrderById(tenantId, id, { branchId = null } = {}) {
  const { rows: orders } = await tenantQuery(
    tenantId,
    `
      SELECT
        po.id,
        po.order_number AS "orderNumber",
        po.status,
        po.explanation,
        po.created_at AS "createdAt",
        po.branch_id AS "branchId",
        po.supplier_id AS "supplierId",
        po.created_by AS "createdBy",
        creator.full_name AS "createdByName",
        po.approved_by AS "approvedBy",
        approver.full_name AS "approvedByName",
        po.approved_at AS "approvedAt",
        po.rejected_by AS "rejectedBy",
        rejector.full_name AS "rejectedByName",
        po.rejected_at AS "rejectedAt",
        po.rejection_notes AS "rejectionNotes",
        po.received_at AS "receivedAt",
        po.completed_by AS "completedBy",
        completer.full_name AS "completedByName",
        s.company_name AS "companyName",
        s.representative_name AS "representativeName",
        s.representative_phone AS "representativePhone",
        s.company_phone AS "companyPhone"
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
      LEFT JOIN users creator ON creator.id = po.created_by AND creator.tenant_id = po.tenant_id
      LEFT JOIN users approver ON approver.id = po.approved_by AND approver.tenant_id = po.tenant_id
      LEFT JOIN users rejector ON rejector.id = po.rejected_by AND rejector.tenant_id = po.tenant_id
      LEFT JOIN users completer ON completer.id = po.completed_by AND completer.tenant_id = po.tenant_id
      WHERE po.tenant_id = $1 AND po.id = $2
        AND ($3::uuid IS NULL OR po.branch_id = $3)
      LIMIT 1
    `,
    [id, branchId || null],
  )
  const order = orders[0]
  if (!order) return null

  // Parallel child reads — cuts detail latency vs sequential round-trips
  const [companiesResult, linesResult, eventsResult] = await Promise.all([
    tenantQuery(
      tenantId,
      `
        SELECT
          pos.id,
          pos.supplier_id AS "supplierId",
          pos.sort_order AS "sortOrder",
          s.company_name AS "companyName",
          s.image_url AS "imageUrl",
          s.representative_name AS "representativeName",
          s.representative_phone AS "representativePhone",
          s.company_phone AS "companyPhone"
        FROM purchase_order_suppliers pos
        JOIN suppliers s ON s.id = pos.supplier_id AND s.tenant_id = pos.tenant_id
        WHERE pos.tenant_id = $1 AND pos.purchase_order_id = $2
        ORDER BY pos.sort_order ASC, pos.created_at ASC
      `,
      [id],
    ),
    tenantQuery(
      tenantId,
      `
        SELECT
          poi.id,
          poi.supplier_id AS "supplierId",
          poi.product_id AS "productId",
          p.name,
          p.item_code AS "itemCode",
          poi.scale,
          poi.quantity,
          poi.received_quantity AS "receivedQuantity",
          poi.unit_cost AS "unitCost",
          poi.last_purchase_price AS "lastPurchasePrice",
          s.company_name AS "supplierCompanyName"
        FROM purchase_order_items poi
        JOIN products p ON p.id = poi.product_id AND p.tenant_id = poi.tenant_id
        LEFT JOIN suppliers s ON s.id = poi.supplier_id AND s.tenant_id = poi.tenant_id
        WHERE poi.tenant_id = $1 AND poi.purchase_order_id = $2
        ORDER BY s.company_name NULLS LAST, p.name
      `,
      [id],
    ),
    tenantQuery(
      tenantId,
      `
        SELECT
          e.id,
          e.event_type AS "eventType",
          e.actor_id AS "actorId",
          u.full_name AS "actorName",
          e.payload,
          e.created_at AS "createdAt"
        FROM purchase_order_events e
        LEFT JOIN users u ON u.id = e.actor_id AND u.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1 AND e.purchase_order_id = $2
        ORDER BY e.created_at ASC
      `,
      [id],
    ),
  ])

  const companyRows = companiesResult.rows
  const lines = linesResult.rows
  const events = eventsResult.rows

  const companies = companyRows.map((company) => ({
    ...company,
    lines: lines.filter((line) => line.supplierId === company.supplierId),
  }))

  const hasRemainingQuantity = lines.some(
    (line) => Number(line.receivedQuantity || 0) < Number(line.quantity || 0),
  )

  return {
    ...order,
    companiesNumber: companies.length || (order.supplierId ? 1 : 0),
    itemsNumber: lines.length,
    hasRemainingQuantity,
    companies,
    lines,
    events,
  }
}

export async function generatePurchaseOrder(tenantId, payload) {
  if (!payload.branchId) throw httpError(422, 'branchId is required to create a purchase order')

  const companies = normalizeCompanies(payload)
  const counts = validateCompanyBlocks(companies)
  const allProductIds = companies.flatMap((block) => block.lines.map((line) => line.productId))
  const allSupplierIds = companies.map((block) => block.supplierId)

  const orderId = await withTransaction(async (client) => {
    await assertActiveSuppliers(client, tenantId, allSupplierIds, payload.branchId)
    const productsById = await assertOrderableProducts(client, tenantId, allProductIds, payload.branchId)

    // IM submit → Pending for Branch Manager review (TL Order Request Flow)
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`
    const primarySupplierId = companies[0].supplierId

    const { rows: orders } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO purchase_orders (
          tenant_id, branch_id, supplier_id, order_number, explanation,
          status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, order_number AS "orderNumber", status, created_by AS "createdBy", branch_id AS "branchId"
      `,
      [
        payload.branchId,
        primarySupplierId,
        orderNumber,
        payload.explanation || null,
        PURCHASE_ORDER_STATUS.PENDING,
        payload.createdBy,
      ],
    )
    const order = orders[0]

    await replaceOrderCompaniesAndLines(client, tenantId, order.id, companies, productsById)

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId: order.id,
      eventType: PURCHASE_ORDER_EVENT_TYPES.CREATED,
      actorId: payload.createdBy,
      payload: {
        companiesNumber: counts.companyCount,
        itemsNumber: counts.itemCount,
      },
    })

    return order.id
  })

  return getPurchaseOrderById(tenantId, orderId, { branchId: payload.branchId })
}

// BM may edit companies / quantities / items while status is Pending
export async function updatePendingPurchaseOrder(tenantId, id, payload, { branchId = null, actorId = null } = {}) {
  const companies = normalizeCompanies(payload)
  const counts = validateCompanyBlocks(companies)
  const allProductIds = companies.flatMap((block) => block.lines.map((line) => line.productId))
  const allSupplierIds = companies.map((block) => block.supplierId)

  await withTransaction(async (client) => {
    const { rows: existingRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, status, branch_id AS "branchId"
        FROM purchase_orders
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        FOR UPDATE
      `,
      [id, branchId || null],
    )
    const existing = existingRows[0]
    if (!existing) throw httpError(404, 'Purchase order not found')
    if (existing.status !== PURCHASE_ORDER_STATUS.PENDING) {
      throw httpError(400, 'Only pending order requests can be edited')
    }

    const scopeBranchId = existing.branchId
    await assertActiveSuppliers(client, tenantId, allSupplierIds, scopeBranchId)
    const productsById = await assertOrderableProducts(client, tenantId, allProductIds, scopeBranchId)

    if (payload.explanation !== undefined) {
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE purchase_orders
          SET supplier_id = $3, explanation = $4
          WHERE tenant_id = $1 AND id = $2
        `,
        [id, companies[0].supplierId, payload.explanation || null],
      )
    } else {
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE purchase_orders
          SET supplier_id = $3
          WHERE tenant_id = $1 AND id = $2
        `,
        [id, companies[0].supplierId],
      )
    }

    await replaceOrderCompaniesAndLines(client, tenantId, id, companies, productsById)

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId: id,
      eventType: PURCHASE_ORDER_EVENT_TYPES.EDITED_BY_BM,
      actorId,
      payload: {
        companiesNumber: counts.companyCount,
        itemsNumber: counts.itemCount,
      },
    })
  })

  return getPurchaseOrderById(tenantId, id, { branchId })
}

export async function priceHistory(tenantId, id, { branchId = null } = {}) {
  const order = await getPurchaseOrderById(tenantId, id, { branchId })
  if (!order) return null

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    companyName: order.companyName,
    lines: order.lines.map((line) => {
      const last = Number(line.lastPurchasePrice ?? 0)
      const current = Number(line.unitCost ?? 0)
      let direction = 'same'
      if (current > last) direction = 'up'
      if (current < last) direction = 'down'
      return {
        productId: line.productId,
        name: line.name,
        itemCode: line.itemCode,
        scale: line.scale,
        lastPurchasePrice: last,
        currentPurchasePrice: current,
        direction,
      }
    }),
  }
}

const RECEIVABLE_STATUSES = new Set([
  PURCHASE_ORDER_STATUS.APPROVED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
])

// TL §6.1 — multi-round receival: tick lines, qty ≤ remaining, ledger linked to order
export async function recordPurchaseOrderReceival(
  tenantId,
  purchaseOrderId,
  payload,
  { branchId = null, actorId = null } = {},
) {
  const incoming = Array.isArray(payload?.lines) ? payload.lines : []
  if (!incoming.length) throw httpError(422, 'Select at least one line to receive')

  const notes = payload?.notes || null

  const result = await withTransaction(async (client) => {
    const { rows: orders } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          id,
          order_number AS "orderNumber",
          supplier_id AS "supplierId",
          status,
          branch_id AS "branchId",
          created_by AS "createdBy"
        FROM purchase_orders
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        FOR UPDATE
      `,
      [purchaseOrderId, branchId || null],
    )
    const order = orders[0]
    if (!order) throw httpError(404, 'Purchase order not found')
    if (order.status === PURCHASE_ORDER_STATUS.RECEIVED) {
      throw httpError(409, 'Purchase order already completed')
    }
    if (order.status === PURCHASE_ORDER_STATUS.CANCELLED) {
      throw httpError(409, 'Cannot receive a cancelled purchase order')
    }
    if (order.status === PURCHASE_ORDER_STATUS.REJECTED) {
      throw httpError(409, 'Cannot receive a rejected purchase order')
    }
    if (order.status === PURCHASE_ORDER_STATUS.PENDING) {
      throw httpError(400, 'Order must be approved before recording receival')
    }
    if (!RECEIVABLE_STATUSES.has(order.status)) {
      throw httpError(400, 'Order is not open for receival')
    }

    const { rows: dbLines } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          id,
          product_id AS "productId",
          supplier_id AS "supplierId",
          scale,
          quantity,
          received_quantity AS "receivedQuantity",
          unit_cost AS "unitCost"
        FROM purchase_order_items
        WHERE tenant_id = $1 AND purchase_order_id = $2
        FOR UPDATE
      `,
      [purchaseOrderId],
    )
    if (!dbLines.length) throw httpError(422, 'Purchase order has no items')

    const byId = new Map(dbLines.map((line) => [line.id, line]))
    const seen = new Set()
    const normalized = []

    for (const row of incoming) {
      const lineId = row.purchaseOrderItemId || row.id
      const qty = Number(row.quantity)
      if (!lineId) throw httpError(422, 'Each receival line requires purchaseOrderItemId')
      if (seen.has(lineId)) throw httpError(422, 'Duplicate line in receival payload')
      seen.add(lineId)

      const line = byId.get(lineId)
      if (!line) throw httpError(404, `Order line not found: ${lineId}`)
      if (!Number.isFinite(qty) || qty <= 0) {
        throw httpError(422, `Received quantity must be positive for line ${lineId}`)
      }

      const ordered = Number(line.quantity) || 0
      const already = Number(line.receivedQuantity) || 0
      const remaining = ordered - already
      if (qty > remaining + 1e-9) {
        throw httpError(
          400,
          `Received quantity (${qty}) exceeds remaining (${remaining}) for line ${lineId}`,
        )
      }

      normalized.push({
        line,
        quantity: qty,
        remainingAfter: remaining - qty,
      })
    }

    const { rows: receivalRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO purchase_order_receivals (
          tenant_id, purchase_order_id, received_by, notes
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at AS "createdAt"
      `,
      [purchaseOrderId, actorId || null, notes],
    )
    const receival = receivalRows[0]

    const ledgerRows = []
    let totalUnits = 0

    for (const entry of normalized) {
      const { line, quantity } = entry
      totalUnits += quantity

      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO purchase_order_receival_items (
            tenant_id, receival_id, purchase_order_item_id, quantity
          )
          VALUES ($1, $2, $3, $4)
        `,
        [receival.id, line.id, quantity],
      )

      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE purchase_order_items
          SET received_quantity = received_quantity + $3
          WHERE tenant_id = $1 AND id = $2
        `,
        [line.id, quantity],
      )

      ledgerRows.push(
        await insertLedgerEventInTx(client, tenantId, {
          productId: line.productId,
          movementType: MOVEMENT_TYPES.IN,
          quantity,
          scale: line.scale,
          supplierId: line.supplierId || order.supplierId,
          purchaseOrderId,
          orderNumber: order.orderNumber,
          unitCost: line.unitCost,
          reason: `PO ${order.orderNumber} receival`,
          createdBy: actorId,
          branchId: order.branchId,
          scopeBranchId: branchId || order.branchId,
        }),
      )
    }

    // otherwise stay Partially Received (Mark Complete still closes early when short).
    const { rows: remainRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT EXISTS (
          SELECT 1
          FROM purchase_order_items
          WHERE tenant_id = $1
            AND purchase_order_id = $2
            AND received_quantity < quantity
        ) AS "hasRemaining"
      `,
      [purchaseOrderId],
    )
    const hasRemaining = Boolean(remainRows[0]?.hasRemaining)
    const nextStatus = hasRemaining
      ? PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED
      : PURCHASE_ORDER_STATUS.RECEIVED

    if (hasRemaining) {
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE purchase_orders
          SET status = $3
          WHERE tenant_id = $1 AND id = $2
        `,
        [purchaseOrderId, nextStatus],
      )
    } else {
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE purchase_orders
          SET status = $3, received_at = now(), completed_by = $4
          WHERE tenant_id = $1 AND id = $2
        `,
        [purchaseOrderId, nextStatus, actorId || null],
      )
    }

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId,
      eventType: PURCHASE_ORDER_EVENT_TYPES.RECEIVAL_RECORDED,
      actorId,
      payload: {
        receivalId: receival.id,
        lineCount: normalized.length,
        totalUnits,
        notes,
        orderStatus: nextStatus,
        autoCompleted: !hasRemaining,
      },
    })

    if (!hasRemaining) {
      await insertOrderEvent(client, tenantId, {
        purchaseOrderId,
        eventType: PURCHASE_ORDER_EVENT_TYPES.COMPLETED,
        actorId,
        payload: { autoCompleted: true },
      })
    }

    return {
      receivalId: receival.id,
      createdAt: receival.createdAt,
      purchaseOrderId,
      orderNumber: order.orderNumber,
      status: nextStatus,
      autoCompleted: !hasRemaining,
      hasRemainingQuantity: hasRemaining,
      branchId: order.branchId,
      createdBy: order.createdBy,
      lineCount: normalized.length,
      totalUnits,
      ledger: ledgerRows,
    }
  })

  const order = await getPurchaseOrderById(tenantId, purchaseOrderId, { branchId })
  return { ...result, order }
}

// TL §6.1 — Mark Complete → received; no further receivals
export async function completePurchaseOrderReceival(
  tenantId,
  purchaseOrderId,
  { branchId = null, actorId = null } = {},
) {
  await withTransaction(async (client) => {
    const { rows: orders } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, status, order_number AS "orderNumber", branch_id AS "branchId"
        FROM purchase_orders
        WHERE tenant_id = $1 AND id = $2
          AND ($3::uuid IS NULL OR branch_id = $3)
        FOR UPDATE
      `,
      [purchaseOrderId, branchId || null],
    )
    const order = orders[0]
    if (!order) throw httpError(404, 'Purchase order not found')
    if (order.status === PURCHASE_ORDER_STATUS.RECEIVED) {
      throw httpError(409, 'Purchase order already completed')
    }
    if (order.status !== PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED) {
      throw httpError(
        400,
        'Mark Complete is only available after at least one receival round (Partially Received)',
      )
    }

    const { rows: updatedRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE purchase_orders
        SET status = $3, received_at = now(), completed_by = $4
        WHERE tenant_id = $1 AND id = $2 AND status = $5
        RETURNING id, status
      `,
      [
        purchaseOrderId,
        PURCHASE_ORDER_STATUS.RECEIVED,
        actorId || null,
        PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
      ],
    )
    if (!updatedRows[0]) {
      throw httpError(409, 'Could not mark order complete — status may have changed')
    }

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId,
      eventType: PURCHASE_ORDER_EVENT_TYPES.COMPLETED,
      actorId,
      payload: {},
    })
  })

  const completed = await getPurchaseOrderById(tenantId, purchaseOrderId, { branchId })
  if (!completed || completed.status !== PURCHASE_ORDER_STATUS.RECEIVED) {
    throw httpError(500, 'Order marked complete but status did not persist as Received')
  }
  return completed
}

// Legacy Control "Order Demand" — receive all remaining then Mark Complete
export async function receivePurchaseOrder(tenantId, purchaseOrderId, userId, { branchId = null } = {}) {
  const order = await getPurchaseOrderById(tenantId, purchaseOrderId, { branchId })
  if (!order) throw httpError(404, 'Purchase order not found')

  const remainingLines = (order.lines || [])
    .map((line) => {
      const remaining = Number(line.quantity) - Number(line.receivedQuantity || 0)
      return remaining > 0
        ? { purchaseOrderItemId: line.id, quantity: remaining }
        : null
    })
    .filter(Boolean)

  if (remainingLines.length) {
    await recordPurchaseOrderReceival(
      tenantId,
      purchaseOrderId,
      { lines: remainingLines, notes: 'Full receive (legacy Order Demand)' },
      { branchId, actorId: userId },
    )
  } else if (order.status === PURCHASE_ORDER_STATUS.APPROVED) {
    throw httpError(422, 'Purchase order has no remaining quantities to receive')
  }

  const completed = await completePurchaseOrderReceival(tenantId, purchaseOrderId, {
    branchId,
    actorId: userId,
  })

  return {
    purchaseOrderId: completed.id,
    orderNumber: completed.orderNumber,
    status: completed.status,
    order: completed,
  }
}

export async function cancelPurchaseOrder(tenantId, id, { branchId = null, actorId = null } = {}) {
  const { rows: existingRows } = await tenantQuery(
    tenantId,
    `
      SELECT id, status
      FROM purchase_orders
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [id, branchId || null],
  )
  const existing = existingRows[0]
  if (!existing) return null
  if (existing.status !== PURCHASE_ORDER_STATUS.PENDING) {
    throw httpError(400, 'Only pending purchase orders can be cancelled')
  }

  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE purchase_orders
      SET status = $3
      WHERE tenant_id = $1 AND id = $2 AND status = $4
        AND ($5::uuid IS NULL OR branch_id = $5)
      RETURNING id, order_number AS "orderNumber", status
    `,
    [id, PURCHASE_ORDER_STATUS.CANCELLED, PURCHASE_ORDER_STATUS.PENDING, branchId || null],
  )
  const updated = rows[0] || null
  if (updated) {
    await withTransaction(async (client) => {
      await insertOrderEvent(client, tenantId, {
        purchaseOrderId: id,
        eventType: PURCHASE_ORDER_EVENT_TYPES.EDITED_BY_BM,
        actorId,
        payload: { action: 'cancelled' },
      })
    })
  }
  return updated
}

export async function approvePurchaseOrder(tenantId, id, userId, { branchId = null } = {}) {
  const { rows: existingRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        status,
        order_number AS "orderNumber",
        created_by AS "createdBy",
        branch_id AS "branchId"
      FROM purchase_orders
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [id, branchId || null],
  )
  const existing = existingRows[0]
  if (!existing) return null
  if (existing.status !== PURCHASE_ORDER_STATUS.PENDING) {
    throw httpError(400, 'Only pending order requests can be approved')
  }

  await withTransaction(async (client) => {
    const { rows: updatedRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE purchase_orders
        SET status = $3, approved_by = $4, approved_at = now(),
            rejected_by = NULL, rejected_at = NULL, rejection_notes = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = $5
          AND ($6::uuid IS NULL OR branch_id = $6)
        RETURNING approved_at AS "approvedAt"
      `,
      [
        id,
        PURCHASE_ORDER_STATUS.APPROVED,
        userId,
        PURCHASE_ORDER_STATUS.PENDING,
        branchId || null,
      ],
    )
    if (!updatedRows[0]) {
      throw httpError(409, 'Could not approve order — status may have changed')
    }

    // TL §10 — one invoice per supplier company (locked to approved quantities)
    const invoices = await createInvoicesForApprovedOrder(client, tenantId, id, {
      invoiceDate: updatedRows[0].approvedAt,
    })

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId: id,
      eventType: PURCHASE_ORDER_EVENT_TYPES.APPROVED,
      actorId: userId,
      payload: {
        invoicesCreated: invoices.filter((row) => !row.skipped).length,
        invoiceNumbers: invoices.map((row) => row.invoiceNumber),
      },
    })

    // Give withTransaction a useful summary log (was "undefined")
    return { id, status: PURCHASE_ORDER_STATUS.APPROVED, invoicesCreated: invoices.length }
  })

  return getPurchaseOrderById(tenantId, id, { branchId })
}

export async function rejectPurchaseOrder(
  tenantId,
  id,
  userId,
  { branchId = null, rejectionNotes = null } = {},
) {
  const { rows: existingRows } = await tenantQuery(
    tenantId,
    `
      SELECT id, status
      FROM purchase_orders
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [id, branchId || null],
  )
  const existing = existingRows[0]
  if (!existing) return null
  if (existing.status !== PURCHASE_ORDER_STATUS.PENDING) {
    throw httpError(400, 'Only pending order requests can be rejected')
  }

  await withTransaction(async (client) => {
    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE purchase_orders
        SET
          status = $3,
          rejected_by = $4,
          rejected_at = now(),
          rejection_notes = $5,
          approved_by = NULL,
          approved_at = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = $6
          AND ($7::uuid IS NULL OR branch_id = $7)
      `,
      [
        id,
        PURCHASE_ORDER_STATUS.REJECTED,
        userId,
        rejectionNotes || null,
        PURCHASE_ORDER_STATUS.PENDING,
        branchId || null,
      ],
    )

    await insertOrderEvent(client, tenantId, {
      purchaseOrderId: id,
      eventType: PURCHASE_ORDER_EVENT_TYPES.REJECTED,
      actorId: userId,
      payload: { rejectionNotes: rejectionNotes || null },
    })
  })

  return getPurchaseOrderById(tenantId, id, { branchId })
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export async function buildPurchaseOrderPrint(tenantId, id, { branchId = null } = {}) {
  const order = await getPurchaseOrderById(tenantId, id, { branchId })
  if (!order) return null

  const lineRows = order.lines
    .map(
      (line) => `
        <tr>
          <td>${escapeHtml(line.name)} (${escapeHtml(line.itemCode)})</td>
          <td>${escapeHtml(line.supplierCompanyName || '')}</td>
          <td>${escapeHtml(line.quantity)}</td>
          <td>${escapeHtml(line.unitCost)}</td>
        </tr>
      `,
    )
    .join('')

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Order Request ${escapeHtml(order.orderNumber)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
      h1 { margin-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
      th { background: #f5f5f5; }
    </style>
  </head>
  <body>
    <h1>Order Request ${escapeHtml(order.orderNumber)}</h1>
    <p><strong>Status:</strong> ${escapeHtml(order.status)}</p>
    <p><strong>Submitted by:</strong> ${escapeHtml(order.createdByName || '—')}</p>
    ${order.explanation ? `<p><strong>Explanation:</strong> ${escapeHtml(order.explanation)}</p>` : ''}
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Supplier</th>
          <th>Quantity</th>
          <th>Unit Cost</th>
        </tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>
  </body>
</html>`

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    companyName: order.companyName,
    status: order.status,
    lines: order.lines,
    html,
  }
}

export async function sendPurchaseOrderSms(tenantId, id, { branchId = null } = {}) {
  const order = await getPurchaseOrderById(tenantId, id, { branchId })
  if (!order) return null
  if (!order.representativePhone) {
    throw httpError(422, 'Supplier representative phone is not set')
  }

  const smsBody = buildPurchaseOrderSms(order)
  const result = await sendSms({ to: order.representativePhone, body: smsBody })

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    recipient: order.representativePhone,
    ...result,
  }
}
