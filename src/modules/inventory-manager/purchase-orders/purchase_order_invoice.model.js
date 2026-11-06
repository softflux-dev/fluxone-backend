import { tenantClientQuery, tenantQuery } from '../../../config/db.js'
import {
  PURCHASE_ORDER_INVOICE_DOWNLOAD_STATUSES,
  PURCHASE_ORDER_STATUS,
} from '../../../config/constants.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function invoiceYearFromDate(invoiceDate = new Date()) {
  const year =
    invoiceDate instanceof Date
      ? invoiceDate.getUTCFullYear()
      : new Date(invoiceDate).getUTCFullYear()
  if (!Number.isFinite(year) || year < 2000) {
    throw httpError(500, 'Invalid invoice year for number allocation')
  }
  return year
}

// INV-2026-00143 — tenant + calendar-year sequence (row locked in tx).
// Allocate `count` numbers in one counter bump (avoids N round-trips on multi-supplier approve).
async function allocateInvoiceNumbers(client, tenantId, invoiceDate = new Date(), count = 1) {
  const n = Math.max(0, Math.trunc(Number(count) || 0))
  if (n <= 0) return []

  const year = invoiceYearFromDate(invoiceDate)

  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO purchase_order_invoice_counters (tenant_id, year, last_value)
      VALUES ($1, $2, 0)
      ON CONFLICT (tenant_id, year) DO NOTHING
    `,
    [year],
  )

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE purchase_order_invoice_counters
      SET last_value = last_value + $3
      WHERE tenant_id = $1 AND year = $2
      RETURNING last_value AS "lastValue", year
    `,
    [year, n],
  )
  const end = Number(rows[0]?.lastValue)
  if (!Number.isFinite(end) || end < n) {
    throw httpError(500, 'Failed to allocate invoice number')
  }
  const start = end - n + 1
  return Array.from({ length: n }, (_, i) => {
    const seq = start + i
    return `INV-${year}-${String(seq).padStart(5, '0')}`
  })
}

function money4(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 10000) / 10000
}

function mapInvoiceHeader(row) {
  if (!row) return null
  return {
    id: row.id,
    purchaseOrderId: row.purchaseOrderId,
    orderNumber: row.orderNumber || null,
    orderStatus: row.orderStatus || null,
    supplierId: row.supplierId,
    branchId: row.branchId,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    supplier: {
      companyName: row.supplierCompanyName || '',
      location: row.supplierLocation || '',
      registrationNumber: row.supplierRegistrationNumber || '',
      representativeName: row.supplierRepresentativeName || '',
      representativeEmail: row.supplierRepresentativeEmail || '',
      signatureUrl: normalizeImageUrl(row.supplierSignatureUrl),
    },
    branch: {
      name: row.branchName || '',
      location: row.branchLocation || '',
      contact: row.branchContact || '',
    },
    lastSentAt: row.lastSentAt || null,
    lastSentTo: row.lastSentTo || null,
    createdAt: row.createdAt || null,
    items: Array.isArray(row.items) ? row.items : undefined,
  }
}

function mapInvoiceItem(row) {
  if (!row) return null
  return {
    id: row.id,
    purchaseOrderItemId: row.purchaseOrderItemId || null,
    productId: row.productId || null,
    itemName: row.itemName || '',
    variantLabel: row.variantLabel || '',
    scale: row.scale || '',
    quantity: Number(row.quantity) || 0,
    previousUnitPrice: money4(row.previousUnitPrice),
    lineTotal: money4(row.lineTotal),
    sortOrder: Number(row.sortOrder) || 0,
  }
}

const invoiceHeaderSelect = `
  inv.id,
  inv.purchase_order_id AS "purchaseOrderId",
  inv.supplier_id AS "supplierId",
  inv.branch_id AS "branchId",
  inv.invoice_number AS "invoiceNumber",
  inv.invoice_date AS "invoiceDate",
  inv.supplier_company_name AS "supplierCompanyName",
  inv.supplier_location AS "supplierLocation",
  inv.supplier_registration_number AS "supplierRegistrationNumber",
  inv.supplier_representative_name AS "supplierRepresentativeName",
  inv.supplier_representative_email AS "supplierRepresentativeEmail",
  inv.supplier_signature_url AS "supplierSignatureUrl",
  inv.branch_name AS "branchName",
  inv.branch_location AS "branchLocation",
  inv.branch_contact AS "branchContact",
  inv.last_sent_at AS "lastSentAt",
  inv.last_sent_to AS "lastSentTo",
  inv.created_at AS "createdAt",
  po.order_number AS "orderNumber",
  po.status AS "orderStatus"
`

// Load approved line blocks + supplier/branch snapshots for invoice creation
async function loadApproveSnapshot(client, tenantId, purchaseOrderId) {
  const { rows: orders } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        po.id,
        po.status,
        po.branch_id AS "branchId",
        po.approved_at AS "approvedAt",
        b.name AS "branchName",
        b.location AS "branchLocation",
        bm.phone AS "branchManagerPhone"
      FROM purchase_orders po
      JOIN branches b ON b.id = po.branch_id AND b.tenant_id = po.tenant_id
      LEFT JOIN LATERAL (
        SELECT u.phone
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = po.tenant_id
          AND u.branch_id = po.branch_id
          AND r.slug = 'branch_manager'
          AND u.is_active = true
        ORDER BY u.created_at ASC
        LIMIT 1
      ) bm ON true
      WHERE po.tenant_id = $1 AND po.id = $2
      LIMIT 1
    `,
    [purchaseOrderId],
  )
  const order = orders[0]
  if (!order) throw httpError(404, 'Purchase order not found')

  const { rows: companies } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        pos.supplier_id AS "supplierId",
        pos.sort_order AS "sortOrder",
        s.company_name AS "companyName",
        s.location,
        s.registration_number AS "registrationNumber",
        s.representative_name AS "representativeName",
        s.representative_email AS "representativeEmail",
        s.signature_url AS "signatureUrl"
      FROM purchase_order_suppliers pos
      JOIN suppliers s ON s.id = pos.supplier_id AND s.tenant_id = pos.tenant_id
      WHERE pos.tenant_id = $1 AND pos.purchase_order_id = $2
      ORDER BY pos.sort_order ASC, pos.created_at ASC
    `,
    [purchaseOrderId],
  )
  if (!companies.length) throw httpError(422, 'Order has no supplier companies for invoicing')

  const { rows: lines } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        poi.id AS "purchaseOrderItemId",
        poi.supplier_id AS "supplierId",
        poi.product_id AS "productId",
        p.name AS "itemName",
        p.variant_label AS "variantLabel",
        poi.scale,
        poi.quantity,
        poi.last_purchase_price AS "lastPurchasePrice",
        poi.unit_cost AS "unitCost"
      FROM purchase_order_items poi
      JOIN products p ON p.id = poi.product_id AND p.tenant_id = poi.tenant_id
      WHERE poi.tenant_id = $1 AND poi.purchase_order_id = $2
      ORDER BY p.name ASC, poi.id ASC
    `,
    [purchaseOrderId],
  )

  return { order, companies, lines }
}

/**
 * Create one invoice per supplier company for an approved order.
 * Idempotent: existing (order, supplier) rows are left unchanged.
 * Call inside the same transaction as approve (B2 wiring).
 *
 * Perf: one existing-invoice lookup, one counter bump for all new numbers,
 * one multi-row INSERT for each invoice's line items (was N+1 per line).
 */
export async function createInvoicesForApprovedOrder(
  client,
  tenantId,
  purchaseOrderId,
  { invoiceDate = null } = {},
) {
  const { order, companies, lines } = await loadApproveSnapshot(client, tenantId, purchaseOrderId)

  // Only generate after approve (or if already past Pending into downloadable statuses)
  if (order.status === PURCHASE_ORDER_STATUS.PENDING) {
    throw httpError(400, 'Invoices can only be created after the order is approved')
  }
  if (order.status === PURCHASE_ORDER_STATUS.REJECTED || order.status === PURCHASE_ORDER_STATUS.CANCELLED) {
    throw httpError(400, 'Cannot create invoices for rejected or cancelled orders')
  }

  const effectiveDate = invoiceDate || order.approvedAt || new Date()
  const branchContact = order.branchManagerPhone || null

  const { rows: existingRows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        supplier_id AS "supplierId",
        invoice_number AS "invoiceNumber"
      FROM purchase_order_invoices
      WHERE tenant_id = $1 AND purchase_order_id = $2
    `,
    [purchaseOrderId],
  )
  const existingBySupplier = new Map(
    existingRows.map((row) => [row.supplierId, row]),
  )

  const created = []
  const toCreate = []

  for (const company of companies) {
    const companyLines = lines.filter((line) => line.supplierId === company.supplierId)
    if (!companyLines.length) continue

    const existing = existingBySupplier.get(company.supplierId)
    if (existing) {
      created.push({
        id: existing.id,
        invoiceNumber: existing.invoiceNumber,
        skipped: true,
      })
      continue
    }
    toCreate.push({ company, companyLines })
  }

  const invoiceNumbers = await allocateInvoiceNumbers(
    client,
    tenantId,
    effectiveDate,
    toCreate.length,
  )

  for (let i = 0; i < toCreate.length; i += 1) {
    const { company, companyLines } = toCreate[i]
    const invoiceNumber = invoiceNumbers[i]
    if (!invoiceNumber) throw httpError(500, 'Failed to allocate invoice number')

    const { rows: inserted } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO purchase_order_invoices (
          tenant_id,
          purchase_order_id,
          supplier_id,
          branch_id,
          invoice_number,
          invoice_date,
          supplier_company_name,
          supplier_location,
          supplier_registration_number,
          supplier_representative_name,
          supplier_representative_email,
          supplier_signature_url,
          branch_name,
          branch_location,
          branch_contact
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15
        )
        RETURNING id, invoice_number AS "invoiceNumber"
      `,
      [
        purchaseOrderId,
        company.supplierId,
        order.branchId,
        invoiceNumber,
        effectiveDate,
        company.companyName || 'Supplier',
        company.location || null,
        company.registrationNumber || null,
        company.representativeName || null,
        company.representativeEmail || null,
        company.signatureUrl || null,
        order.branchName || 'Branch',
        order.branchLocation || null,
        branchContact,
      ],
    )
    const invoice = inserted[0]
    if (!invoice) throw httpError(500, 'Failed to insert purchase order invoice')

    const itemRows = []
    let sortOrder = 0
    for (const line of companyLines) {
      const qty = Number(line.quantity) || 0
      if (qty <= 0) continue
      const unitPrice = money4(
        line.lastPurchasePrice != null && line.lastPurchasePrice !== ''
          ? line.lastPurchasePrice
          : line.unitCost,
      )
      const lineTotal = money4(qty * unitPrice)
      sortOrder += 1
      itemRows.push({
        purchaseOrderItemId: line.purchaseOrderItemId,
        productId: line.productId,
        itemName: line.itemName || 'Item',
        variantLabel: line.variantLabel || null,
        scale: line.scale || null,
        qty,
        unitPrice,
        lineTotal,
        sortOrder,
      })
    }

    if (itemRows.length) {
      const params = []
      const valueSql = itemRows
        .map((row, idx) => {
          const base = idx * 11
          params.push(
            tenantId,
            invoice.id,
            row.purchaseOrderItemId,
            row.productId,
            row.itemName,
            row.variantLabel,
            row.scale,
            row.qty,
            row.unitPrice,
            row.lineTotal,
            row.sortOrder,
          )
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`
        })
        .join(',\n          ')

      // tenantClientQuery prefixes tenantId as $1 — build absolute placeholders carefully.
      // Use a plain client.query with tenant_id already in VALUES to avoid double-prefix issues.
      await client.query(
        `
          INSERT INTO purchase_order_invoice_items (
            tenant_id,
            invoice_id,
            purchase_order_item_id,
            product_id,
            item_name,
            variant_label,
            scale,
            quantity,
            previous_unit_price,
            line_total,
            sort_order
          )
          VALUES
          ${valueSql}
        `,
        params,
      )
    }

    created.push({ id: invoice.id, invoiceNumber: invoice.invoiceNumber, skipped: false })
  }

  return created
}

export function canDownloadOrderInvoices(orderStatus) {
  return PURCHASE_ORDER_INVOICE_DOWNLOAD_STATUSES.includes(orderStatus)
}

// List invoices for one order (headers only — items loaded on detail)
export async function listInvoicesForOrder(tenantId, purchaseOrderId, { branchId = null } = {}) {
  const { rows: orders } = await tenantQuery(
    tenantId,
    `
      SELECT id, status, branch_id AS "branchId"
      FROM purchase_orders
      WHERE tenant_id = $1 AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      LIMIT 1
    `,
    [purchaseOrderId, branchId || null],
  )
  const order = orders[0]
  if (!order) return null

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${invoiceHeaderSelect}
      FROM purchase_order_invoices inv
      JOIN purchase_orders po ON po.id = inv.purchase_order_id AND po.tenant_id = inv.tenant_id
      WHERE inv.tenant_id = $1 AND inv.purchase_order_id = $2
      ORDER BY inv.invoice_number ASC
    `,
    [purchaseOrderId],
  )

  return {
    purchaseOrderId: order.id,
    orderStatus: order.status,
    canDownload: canDownloadOrderInvoices(order.status),
    items: rows.map((row) => mapInvoiceHeader(row)),
  }
}

export async function getInvoiceById(tenantId, invoiceId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${invoiceHeaderSelect}
      FROM purchase_order_invoices inv
      JOIN purchase_orders po ON po.id = inv.purchase_order_id AND po.tenant_id = inv.tenant_id
      WHERE inv.tenant_id = $1 AND inv.id = $2
        AND ($3::uuid IS NULL OR po.branch_id = $3)
      LIMIT 1
    `,
    [invoiceId, branchId || null],
  )
  const header = rows[0]
  if (!header) return null

  const { rows: itemRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        purchase_order_item_id AS "purchaseOrderItemId",
        product_id AS "productId",
        item_name AS "itemName",
        variant_label AS "variantLabel",
        scale,
        quantity,
        previous_unit_price AS "previousUnitPrice",
        line_total AS "lineTotal",
        sort_order AS "sortOrder"
      FROM purchase_order_invoice_items
      WHERE tenant_id = $1 AND invoice_id = $2
      ORDER BY sort_order ASC, created_at ASC
    `,
    [invoiceId],
  )

  return mapInvoiceHeader({
    ...header,
    items: itemRows.map(mapInvoiceItem),
  })
}

// Mark send attempt after mail.service
export async function markInvoiceSent(client, tenantId, invoiceId, { sentTo, sentAt = new Date() } = {}) {
  if (!sentTo) throw httpError(422, 'sentTo email is required')
  const runner = client
    ? (text, params) => tenantClientQuery(client, tenantId, text, params)
    : (text, params) => tenantQuery(tenantId, text, params)

  const { rows } = await runner(
    `
      UPDATE purchase_order_invoices
      SET last_sent_at = $3, last_sent_to = $4
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, invoice_number AS "invoiceNumber", last_sent_at AS "lastSentAt", last_sent_to AS "lastSentTo"
    `,
    [invoiceId, sentAt, String(sentTo).trim()],
  )
  return rows[0] || null
}

// Active BM contacts for “invoice emailed” confirmation mail
export async function listBranchManagerContactsForOrder(tenantId, branchId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT u.id, u.full_name AS "fullName", u.email
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1
        AND r.slug = 'branch_manager'
        AND u.is_active = true
        AND ($2::uuid IS NULL OR u.branch_id = $2)
      ORDER BY u.created_at ASC
    `,
    [branchId || null],
  )
  return rows
}
