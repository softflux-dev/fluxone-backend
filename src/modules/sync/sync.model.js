// sync.model.js — raw SQL + transactions for POS sync ingest and snapshots.
// Purpose: store pos_sync_events; apply sale/refund/price/cashier_log; build bootstrap/delta.
// Cashier logs: ingestCashierLogEvent → activityLog.util.js → activity_logs (source: pos).
// Read next: sync.errors.js (codes), sync.mapper.js (POS response shape), docs/SYNC_FLOW.md.

import { tenantClientQuery, tenantQuery, withTransaction } from '../../config/db.js'
import { INVOICE_TYPES, MOVEMENT_TYPES, ROLES, SALE_STATUS } from '../../config/constants.js'
import { insertLedgerEventInTx } from '../inventory-manager/control/control.model.js'
import {
  formatZodIssues,
  validateCashierLogPayload,
  validateProductPricePayload,
  validateRefundPayload,
  validateSalePayload,
  zodErrorDetails,
} from './sync.validator.js'
import {
  SYNC_ERROR_CODES,
  buildPushEventContext,
  syncHttpError,
} from './sync.errors.js'
import { logActivity } from '../../utils/activityLog.util.js'
import { normalizeImageUrl } from '../../utils/uploadUrl.util.js'

function throwSaleValidationError(label, syncEvent, parsed) {
  const details = zodErrorDetails(parsed.error)
  const fieldPaths = (details.issues || []).map((i) => i.path).filter(Boolean)
  const code =
    syncEvent.eventType === 'refund'
      ? SYNC_ERROR_CODES.REFUND_VALIDATION_FAILED
      : syncEvent.eventType === 'cashier_log'
        ? SYNC_ERROR_CODES.CASHIER_LOG_VALIDATION_FAILED
        : SYNC_ERROR_CODES.SALE_VALIDATION_FAILED

  console.error(`[sync] ${label} validation failed`, {
    clientEventId: syncEvent.clientEventId,
    eventType: syncEvent.eventType,
    syncEventId: syncEvent.id || null,
    code,
    fieldPaths,
    context: buildPushEventContext(syncEvent.eventType, syncEvent.payload),
    ...details,
  })

  throw syncHttpError(422, `${label}: ${formatZodIssues(parsed.error)}`, {
    code,
    details,
    fieldPaths,
  })
}

// ---------------------------------------------------------------------------
// Sync event storage
// ---------------------------------------------------------------------------

async function insertSyncEventInTx(client, tenantId, event) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO pos_sync_events (
        tenant_id, branch_id, device_id, event_type, payload, client_event_id, synced_by
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (tenant_id, client_event_id) DO NOTHING
      RETURNING
        id,
        client_event_id AS "clientEventId",
        event_type AS "eventType",
        payload,
        branch_id AS "branchId"
    `,
    [
      event.branchId || null,
      event.deviceId || null,
      event.eventType,
      JSON.stringify(event.payload || {}),
      event.clientEventId,
      event.syncedBy || null,
    ],
  )

  if (rows[0]) return { ...rows[0], inserted: true }

  const { rows: existing } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        client_event_id AS "clientEventId",
        event_type AS "eventType",
        payload,
        branch_id AS "branchId"
      FROM pos_sync_events
      WHERE tenant_id = $1 AND client_event_id = $2
      LIMIT 1
    `,
    [event.clientEventId],
  )
  return existing[0] ? { ...existing[0], inserted: false } : null
}

export async function insertSyncEvent(tenantId, event) {
  return withTransaction((client) => insertSyncEventInTx(client, tenantId, event))
}

async function eventAlreadyProcessed(client, tenantId, posEventId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id FROM sales WHERE tenant_id = $1 AND pos_event_id = $2
      UNION ALL
      SELECT id FROM inventory_ledger WHERE tenant_id = $1 AND pos_event_id = $2
      LIMIT 1
    `,
    [posEventId],
  )
  return Boolean(rows[0])
}

async function upsertPosCounter(client, tenantId, branchId, code) {
  if (!code) return null
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO pos_counters (tenant_id, branch_id, code, name, is_active)
      VALUES ($1, $2, $3, $3, true)
      ON CONFLICT (tenant_id, branch_id, code)
      DO UPDATE SET is_active = true
      RETURNING id
    `,
    [branchId, code],
  )
  return rows[0]?.id || null
}

async function resolveStaffId(client, tenantId, userId, branchId) {
  if (!userId) return null
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT s.id
      FROM staff s
      WHERE s.tenant_id = $1 AND s.user_id = $2
        AND ($3::uuid IS NULL OR s.branch_id = $3)
      LIMIT 1
    `,
    [userId, branchId],
  )
  return rows[0]?.id || null
}

async function insertSaleInTx(client, tenantId, { branchId, counterId, payload, staffId, posEventId }) {
  const invoiceType =
    payload.invoiceType ||
    (payload.exchange ? INVOICE_TYPES.EXCHANGE : INVOICE_TYPES.SALE)

  // Freeze invoice currency at write time — later tenant currency changes do not rewrite this row
  let currency = payload.currency || null
  if (!currency) {
    const { rows: curRows } = await tenantClientQuery(
      client,
      tenantId,
      `SELECT COALESCE(default_currency, 'PKR') AS currency FROM tenants WHERE id = $1 LIMIT 1`,
    )
    currency = curRows[0]?.currency || 'PKR'
  }

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO sales (
        tenant_id, branch_id, counter_id, sale_number, sold_at,
        subtotal, tax_amount, discount_amount, final_amount,
        paid_amount, return_amount, status, invoice_type,
        original_sale_number, staff_id, pos_event_id, currency, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
      RETURNING id
    `,
    [
      branchId,
      counterId,
      payload.saleNumber || null,
      payload.soldAt || new Date().toISOString(),
      payload.subtotal ?? 0,
      payload.taxAmount ?? 0,
      payload.discountAmount ?? 0,
      payload.finalAmount ?? 0,
      payload.paidAmount ?? 0,
      payload.returnAmount ?? 0,
      payload.status || SALE_STATUS.COMPLETED,
      invoiceType,
      payload.originalInvoiceId || null,
      staffId,
      posEventId,
      String(currency).toUpperCase().slice(0, 3),
    ],
  )
  return rows[0].id
}

async function insertSaleItemsInTx(client, tenantId, saleId, lines) {
  for (const line of lines) {
    await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO sale_items (
          tenant_id, sale_id, product_id, quantity, unit_price,
          discount_amount, tax_amount, line_total, is_exchange, is_returned
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        saleId,
        line.productId,
        line.quantity,
        line.unitPrice ?? 0,
        line.discountAmount ?? 0,
        line.taxAmount ?? 0,
        line.lineTotal ?? 0,
        line.isExchange ?? false,
        line.isReturned ?? false,
      ],
    )
  }
}

// Prefer canonical live invoice when legacy duplicate sale_numbers exist.
async function findSaleByNumber(client, tenantId, branchId, saleNumber) {
  if (!saleNumber) return null
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        sale_number AS "saleNumber",
        status,
        invoice_type AS "invoiceType",
        original_sale_number AS "originalSaleNumber"
      FROM sales
      WHERE tenant_id = $1
        AND branch_id = $2
        AND sale_number = $3
      ORDER BY
        CASE status
          WHEN 'completed' THEN 0
          WHEN 'partial_refund' THEN 1
          WHEN 'refunded' THEN 2
          ELSE 3
        END,
        created_at ASC
      LIMIT 1
    `,
    [branchId, saleNumber],
  )
  return rows[0] || null
}

async function updateSaleHeaderInTx(client, tenantId, saleId, fields) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE sales
      SET
        subtotal = COALESCE($3::numeric, subtotal),
        tax_amount = COALESCE($4::numeric, tax_amount),
        discount_amount = COALESCE($5::numeric, discount_amount),
        final_amount = COALESCE($6::numeric, final_amount),
        paid_amount = COALESCE($7::numeric, paid_amount),
        return_amount = COALESCE($8::numeric, return_amount),
        status = COALESCE($9::text, status),
        invoice_type = COALESCE($10::text, invoice_type),
        original_sale_number = COALESCE($11::text, original_sale_number),
        staff_id = COALESCE($12::uuid, staff_id),
        counter_id = COALESCE($13::uuid, counter_id),
        pos_event_id = COALESCE($14::uuid, pos_event_id),
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING id
    `,
    [
      saleId,
      fields.subtotal,
      fields.taxAmount,
      fields.discountAmount,
      fields.finalAmount,
      fields.paidAmount,
      fields.returnAmount,
      fields.status,
      fields.invoiceType,
      fields.originalSaleNumber,
      fields.staffId,
      fields.counterId,
      fields.posEventId,
    ],
  )
  return rows[0]?.id || null
}

async function markSaleItemsReturnedInTx(client, tenantId, saleId, lines) {
  for (const line of lines) {
    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE sale_items
        SET is_returned = true
        WHERE tenant_id = $1
          AND sale_id = $2
          AND product_id = $3
          AND is_returned = false
      `,
      [saleId, line.productId],
    )
  }
}

async function deleteSaleItemsForProductsInTx(client, tenantId, saleId, lines) {
  for (const line of lines) {
    await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM sale_items
        WHERE tenant_id = $1
          AND sale_id = $2
          AND product_id = $3
          AND is_returned = false
      `,
      [saleId, line.productId],
    )
  }
}

async function countOpenSaleItems(client, tenantId, saleId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT count(*)::int AS n
      FROM sale_items
      WHERE tenant_id = $1 AND sale_id = $2 AND is_returned = false
    `,
    [saleId],
  )
  return rows[0]?.n || 0
}

async function applyLedgerLines(client, tenantId, syncEvent, payload, movementType, userId) {
  const reason =
    payload.reason ||
    (syncEvent.eventType === 'sale' ? 'POS sale' : 'POS refund')
  const branchId = syncEvent.branchId || null
  const ledgerLines = []

  for (const line of payload.lines) {
    try {
      ledgerLines.push(
        await insertLedgerEventInTx(client, tenantId, {
          productId: line.productId,
          movementType,
          quantity: line.quantity,
          scale: line.scale || 'unit',
          reason,
          posEventId: syncEvent.id,
          branchId,
          createdBy: userId,
        }),
      )
    } catch (err) {
      const code = String(err?.message || '').includes('branch stock')
        ? SYNC_ERROR_CODES.INSUFFICIENT_BRANCH_STOCK
        : String(err?.message || '').includes('Insufficient stock')
          ? SYNC_ERROR_CODES.INSUFFICIENT_STOCK
          : String(err?.message || '').includes('inactive')
            ? SYNC_ERROR_CODES.PRODUCT_INACTIVE
            : String(err?.message || '').includes('Product not found')
              ? SYNC_ERROR_CODES.PRODUCT_NOT_FOUND
              : null
      if (code) {
        throw syncHttpError(err.status || 422, err.message, {
          code,
          fieldPaths: ['lines.productId'],
          details: {
            productId: line.productId,
            quantity: line.quantity,
            movementType,
            saleNumber: payload.saleNumber || null,
          },
        })
      }
      throw err
    }
  }

  return ledgerLines
}

function isExchangeSalePayload(payload) {
  return Boolean(
    payload.exchange ||
      payload.lines?.some((line) => line.isExchange),
  )
}

function isExchangeGivenRefund(payload) {
  const reason = String(payload.reason || '').toLowerCase()
  return reason === 'exchange_given' || reason.includes('exchange_given')
}

export async function ingestSaleEvent(client, tenantId, syncEvent, userId) {
  const parsed = validateSalePayload(syncEvent.payload)
  if (!parsed.success) {
    throwSaleValidationError('Sale payload validation failed', syncEvent, parsed)
  }

  if (await eventAlreadyProcessed(client, tenantId, syncEvent.id)) {
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: true,
      saleId: null,
    }
  }

  const branchId = syncEvent.branchId
  if (!branchId) {
    throw syncHttpError(422, 'Sale events require branchId on the sync token', {
      code: SYNC_ERROR_CODES.BRANCH_REQUIRED,
    })
  }

  const payload = parsed.data
  const counterId = await upsertPosCounter(client, tenantId, branchId, payload.counterCode)
  const staffId = await resolveStaffId(client, tenantId, payload.staffUserId, branchId)
  const exchangeSale = isExchangeSalePayload(payload)
  const existing = await findSaleByNumber(client, tenantId, branchId, payload.saleNumber)

  // Duplicate sale_number (non-exchange): never insert a second cloud row
  if (existing && !exchangeSale) {
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: true,
      saleId: existing.id,
      reason: 'sale_number_exists',
      code: 'sale_number_exists',
      retryable: false,
      hint: 'This saleNumber already exists on cloud. Treat as synced; do not re-push as a new sale.',
    }
  }

  // Exchange received leg: mutate same invoice (POS does not create a new INV)
  if (exchangeSale && existing) {
    await insertSaleItemsInTx(client, tenantId, existing.id, payload.lines)
    await updateSaleHeaderInTx(client, tenantId, existing.id, {
      subtotal: payload.subtotal ?? 0,
      taxAmount: payload.taxAmount ?? 0,
      discountAmount: payload.discountAmount ?? 0,
      finalAmount: payload.finalAmount ?? 0,
      paidAmount: payload.paidAmount ?? 0,
      returnAmount: payload.returnAmount ?? 0,
      status: SALE_STATUS.COMPLETED,
      invoiceType: INVOICE_TYPES.EXCHANGE,
      originalSaleNumber: payload.originalInvoiceId || existing.originalSaleNumber || null,
      staffId,
      counterId,
      posEventId: syncEvent.id,
    })
    await applyLedgerLines(client, tenantId, syncEvent, payload, MOVEMENT_TYPES.OUT, userId)
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: false,
      saleId: existing.id,
    }
  }

  // Normal first sale (or exchange without prior row — rare)
  const salePayload = {
    ...payload,
    status: payload.status || SALE_STATUS.COMPLETED,
    invoiceType: exchangeSale ? INVOICE_TYPES.EXCHANGE : INVOICE_TYPES.SALE,
  }

  const saleId = await insertSaleInTx(client, tenantId, {
    branchId,
    counterId,
    payload: salePayload,
    staffId,
    posEventId: syncEvent.id,
  })

  await insertSaleItemsInTx(client, tenantId, saleId, payload.lines)
  await applyLedgerLines(client, tenantId, syncEvent, payload, MOVEMENT_TYPES.OUT, userId)

  return {
    clientEventId: syncEvent.clientEventId,
    skipped: false,
    saleId,
  }
}

export async function ingestRefundEvent(client, tenantId, syncEvent, userId) {
  const parsed = validateRefundPayload(syncEvent.payload)
  if (!parsed.success) {
    throwSaleValidationError('Refund payload validation failed', syncEvent, parsed)
  }

  if (await eventAlreadyProcessed(client, tenantId, syncEvent.id)) {
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: true,
      saleId: null,
    }
  }

  const branchId = syncEvent.branchId
  if (!branchId) {
    throw syncHttpError(422, 'Refund events require branchId on the sync token', {
      code: SYNC_ERROR_CODES.BRANCH_REQUIRED,
    })
  }

  const payload = parsed.data
  if (!payload.saleNumber) {
    throw syncHttpError(422, 'Refund events require invoiceId / saleNumber', {
      code: SYNC_ERROR_CODES.REFUND_MISSING_INVOICE,
      fieldPaths: ['saleNumber'],
    })
  }

  const counterId = await upsertPosCounter(client, tenantId, branchId, payload.counterCode)
  const staffId = await resolveStaffId(client, tenantId, payload.staffUserId, branchId)
  const exchangeGiven = isExchangeGivenRefund(payload)
  let existing = await findSaleByNumber(client, tenantId, branchId, payload.saleNumber)

  // Forward path: UPDATE original invoice (POS-aligned). Do not insert a second refunded row.
  if (!existing) {
    // Sale not synced yet — create shell then apply return/exchange-given on it
    const shellStatus = exchangeGiven ? SALE_STATUS.COMPLETED : SALE_STATUS.REFUNDED
    const shellType = exchangeGiven ? INVOICE_TYPES.EXCHANGE : INVOICE_TYPES.RETURN
    const saleId = await insertSaleInTx(client, tenantId, {
      branchId,
      counterId,
      payload: {
        ...payload,
        status: shellStatus,
        invoiceType: shellType,
        subtotal: exchangeGiven ? payload.subtotal ?? 0 : 0,
        taxAmount: exchangeGiven ? payload.taxAmount ?? 0 : 0,
        discountAmount: exchangeGiven ? payload.discountAmount ?? 0 : 0,
        finalAmount: exchangeGiven ? payload.finalAmount ?? 0 : 0,
      },
      staffId,
      posEventId: syncEvent.id,
    })
    existing = {
      id: saleId,
      saleNumber: payload.saleNumber,
      status: shellStatus,
      invoiceType: shellType,
      originalSaleNumber: payload.originalInvoiceId || null,
    }
    if (!exchangeGiven) {
      await insertSaleItemsInTx(
        client,
        tenantId,
        saleId,
        payload.lines.map((line) => ({ ...line, isReturned: true })),
      )
    }
  }

  await applyLedgerLines(client, tenantId, syncEvent, payload, MOVEMENT_TYPES.IN, userId)

  if (exchangeGiven) {
    await deleteSaleItemsForProductsInTx(client, tenantId, existing.id, payload.lines)
    await updateSaleHeaderInTx(client, tenantId, existing.id, {
      status: SALE_STATUS.COMPLETED,
      invoiceType: INVOICE_TYPES.EXCHANGE,
      originalSaleNumber: payload.originalInvoiceId || existing.originalSaleNumber || null,
      staffId,
      counterId,
      posEventId: syncEvent.id,
      // totals refreshed on exchange sale leg
      subtotal: null,
      taxAmount: null,
      discountAmount: null,
      finalAmount: null,
      paidAmount: null,
      returnAmount: null,
    })
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: false,
      saleId: existing.id,
    }
  }

  await markSaleItemsReturnedInTx(client, tenantId, existing.id, payload.lines)
  const openCount = await countOpenSaleItems(client, tenantId, existing.id)
  const fullReturn =
    openCount === 0 ||
    payload.status === SALE_STATUS.REFUNDED ||
    String(payload.status || '').toLowerCase() === 'return'

  if (fullReturn) {
    await updateSaleHeaderInTx(client, tenantId, existing.id, {
      subtotal: 0,
      taxAmount: 0,
      discountAmount: 0,
      finalAmount: 0,
      paidAmount: payload.paidAmount ?? null,
      returnAmount: payload.returnAmount ?? null,
      status: SALE_STATUS.REFUNDED,
      invoiceType: INVOICE_TYPES.RETURN,
      originalSaleNumber: payload.originalInvoiceId || existing.originalSaleNumber || null,
      staffId,
      counterId,
      posEventId: syncEvent.id,
    })
  } else {
    await updateSaleHeaderInTx(client, tenantId, existing.id, {
      subtotal: payload.subtotal ?? null,
      taxAmount: payload.taxAmount ?? null,
      discountAmount: payload.discountAmount ?? null,
      finalAmount: payload.finalAmount ?? null,
      paidAmount: payload.paidAmount ?? null,
      returnAmount: payload.returnAmount ?? null,
      status: SALE_STATUS.PARTIAL_REFUND,
      invoiceType: existing.invoiceType === INVOICE_TYPES.EXCHANGE ? INVOICE_TYPES.EXCHANGE : INVOICE_TYPES.SALE,
      originalSaleNumber: payload.originalInvoiceId || existing.originalSaleNumber || null,
      staffId,
      counterId,
      posEventId: syncEvent.id,
    })
  }

  return {
    clientEventId: syncEvent.clientEventId,
    skipped: false,
    saleId: existing.id,
  }
}

// POS Items Rate → cloud products.selling_price (Policy A: branch-scoped product row).
// Final Price is derived on read (selling × discount/offer once × tax) — no stored final column.
export async function ingestProductPriceUpdate(client, tenantId, syncEvent) {
  const parsed = validateProductPricePayload(syncEvent.payload)
  if (!parsed.success) {
    const details = zodErrorDetails(parsed.error)
    throw syncHttpError(
      422,
      `product_price_update validation failed: ${formatZodIssues(parsed.error)}`,
      {
        code: SYNC_ERROR_CODES.PRICE_VALIDATION_FAILED,
        details,
        fieldPaths: (details.issues || []).map((i) => i.path).filter(Boolean),
      },
    )
  }

  const branchId = syncEvent.branchId
  if (!branchId) {
    throw syncHttpError(422, 'product_price_update requires branchId on the sync token', {
      code: SYNC_ERROR_CODES.BRANCH_REQUIRED,
    })
  }

  const payload = parsed.data
  if (payload.branchId && payload.branchId !== branchId) {
    throw syncHttpError(403, 'Branch access denied for product price update', {
      code: SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED,
    })
  }

  // Idempotent replay of the same clientEventId
  if (!syncEvent.inserted) {
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: true,
      saleId: null,
      productId: payload.productId,
      sellingPrice: payload.sellingPrice,
      reason: 'duplicate_client_event_id',
      code: 'duplicate_client_event_id',
      retryable: false,
      hint: 'Same clientEventId already processed. Mark as synced locally.',
    }
  }

  const { rows: existingRows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        id,
        selling_price AS "sellingPrice",
        discount_percent AS "discountPercent",
        branch_id AS "branchId",
        updated_at AS "updatedAt"
      FROM products
      WHERE tenant_id = $1
        AND id = $2
        AND branch_id = $3
      LIMIT 1
    `,
    [payload.productId, branchId],
  )

  const product = existingRows[0]
  if (!product) {
    throw syncHttpError(404, 'Product not found for this branch', {
      code: SYNC_ERROR_CODES.PRODUCT_NOT_FOUND,
      fieldPaths: ['productId'],
      details: { productId: payload.productId, branchId },
    })
  }

  // Optional stale guard: cloud newer than POS timestamp → skip overwrite
  if (payload.updatedAt && product.updatedAt) {
    const posTs = Date.parse(payload.updatedAt)
    const cloudTs = new Date(product.updatedAt).getTime()
    if (Number.isFinite(posTs) && Number.isFinite(cloudTs) && cloudTs > posTs) {
      return {
        clientEventId: syncEvent.clientEventId,
        skipped: true,
        saleId: null,
        productId: product.id,
        sellingPrice: Number(product.sellingPrice),
        reason: 'stale_pos_updated_at',
        code: 'stale_pos_updated_at',
        retryable: false,
        hint: 'Cloud product is newer. Pull delta/bootstrap price; do not overwrite.',
      }
    }
  }

  const nextDiscount =
    payload.discountPercent !== undefined ? payload.discountPercent : product.discountPercent

  const { rows: updatedRows } = await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE products
      SET
        last_selling_price = CASE
          WHEN selling_price IS DISTINCT FROM $4::numeric THEN selling_price
          ELSE last_selling_price
        END,
        selling_price = $4::numeric,
        discount_percent = $5::numeric,
        updated_at = now()
      WHERE tenant_id = $1
        AND id = $2
        AND branch_id = $3
      RETURNING
        id AS "productId",
        selling_price AS "sellingPrice",
        discount_percent AS "discountPercent",
        updated_at AS "updatedAt"
    `,
    [payload.productId, branchId, payload.sellingPrice, nextDiscount],
  )

  const updated = updatedRows[0]
  if (!updated) {
    throw syncHttpError(404, 'Product not found for this branch', {
      code: SYNC_ERROR_CODES.PRODUCT_NOT_FOUND,
      fieldPaths: ['productId'],
      details: { productId: payload.productId, branchId },
    })
  }

  return {
    clientEventId: syncEvent.clientEventId,
    skipped: false,
    saleId: null,
    productId: updated.productId,
    sellingPrice: Number(updated.sellingPrice),
    discountPercent:
      updated.discountPercent === null || updated.discountPercent === undefined
        ? null
        : Number(updated.discountPercent),
    updatedAt: updated.updatedAt,
  }
}

/**
 * POS cashier_log → activity_logs (also stored in pos_sync_events by caller).
 * Idempotent on clientEventId: replay skips when sync row already existed.
 * TODO (later polish): optionally map sale/refund into activity_logs as well.
 */
export async function ingestCashierLogEvent(client, tenantId, syncEvent, event = {}) {
  const parsed = validateCashierLogPayload(syncEvent.payload)
  if (!parsed.success) {
    throwSaleValidationError('cashier_log', syncEvent, parsed)
  }

  const payload = parsed.data
  const branchId = payload.branchId || syncEvent.branchId
  if (!branchId) {
    throw syncHttpError(422, 'cashier_log requires branchId on the payload or sync token', {
      code: SYNC_ERROR_CODES.BRANCH_REQUIRED,
    })
  }

  if (payload.branchId && syncEvent.branchId && payload.branchId !== syncEvent.branchId) {
    throw syncHttpError(403, 'Branch access denied for cashier_log', {
      code: SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED,
    })
  }

  // Idempotent replay of the same clientEventId (matches product_price_update style)
  if (!syncEvent.inserted) {
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: true,
      saleId: null,
      activityLogId: null,
      reason: 'duplicate_client_event_id',
      code: 'duplicate_client_event_id',
      retryable: false,
      hint: 'Same clientEventId already processed. Mark as synced locally.',
    }
  }

  const deviceId = payload.deviceId || event.deviceId || null
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {}

  // details: metadata + deviceId + employeeId (traceability; employeeId ≠ cloud users.id)
  const details = {
    ...metadata,
    ...(deviceId ? { deviceId } : {}),
    ...(payload.employeeId ? { employeeId: payload.employeeId } : {}),
  }

  const activity = await logActivity(
    tenantId,
    {
      branchId,
      source: 'pos',
      actorUserId: payload.actorUserId || null,
      actorName: payload.actorName,
      actorRole: payload.actorRole || 'cashier',
      action: payload.action,
      entityType: payload.entityType || null,
      entityId: payload.entityId != null ? payload.entityId : null,
      details,
      createdAt: payload.timestamp,
      posEventId: syncEvent.id,
      clientEventId: syncEvent.clientEventId,
    },
    client,
  )

  return {
    clientEventId: syncEvent.clientEventId,
    skipped: false,
    saleId: null,
    activityLogId: activity.id,
    action: activity.action,
    actorName: activity.actorName,
  }
}

export async function ingestSyncEvent(tenantId, event, userId) {
  return withTransaction(async (client) => {
    const syncEvent = await insertSyncEventInTx(client, tenantId, event)
    if (!syncEvent) {
      throw syncHttpError(500, 'Failed to store sync event', {
        code: SYNC_ERROR_CODES.SYNC_STORE_FAILED,
      })
    }

    if (event.eventType === 'sale') {
      return ingestSaleEvent(client, tenantId, syncEvent, userId)
    }
    if (event.eventType === 'refund') {
      return ingestRefundEvent(client, tenantId, syncEvent, userId)
    }
    if (event.eventType === 'product_price_update' || event.eventType === 'price_change') {
      return ingestProductPriceUpdate(client, tenantId, syncEvent)
    }
    if (event.eventType === 'cashier_log') {
      return ingestCashierLogEvent(client, tenantId, syncEvent, event)
    }

    // attendance — pos_sync_events only (Phase 1)
    return {
      clientEventId: syncEvent.clientEventId,
      skipped: !syncEvent.inserted,
      saleId: null,
      reason: syncEvent.inserted ? undefined : 'duplicate_client_event_id',
      ...(syncEvent.inserted
        ? {}
        : {
            code: 'duplicate_client_event_id',
            retryable: false,
            hint: 'Same clientEventId already processed. Mark as synced locally.',
          }),
    }
  })
}

export async function listSyncEvents(tenantId, { since, branchId } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        event_type AS "eventType",
        payload,
        client_event_id AS "clientEventId",
        branch_id AS "branchId",
        created_at AS "createdAt"
      FROM pos_sync_events
      WHERE tenant_id = $1
        AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
        AND ($3::uuid IS NULL OR branch_id = $3::uuid)
      ORDER BY created_at ASC
    `,
    [since || null, branchId || null],
  )
  return rows
}

function mapPosInvoiceType(row) {
  if (row.invoiceType === INVOICE_TYPES.RETURN || row.status === SALE_STATUS.REFUNDED) {
    return 'Return'
  }
  if (row.invoiceType === INVOICE_TYPES.EXCHANGE) {
    return 'Exchange'
  }
  return 'Sale'
}

function mapPosPaymentStatus(type) {
  if (type === 'Return') return 'Return'
  if (type === 'Exchange') return 'Adjust'
  return 'Paid'
}

// Cloud → POS sales history (current state, one row per saleNumber).
// Does NOT adjust stock — POS applies invoices only; stock from branch_inventory / push.
// Legacy: when duplicate sale_numbers exist, prefer completed/partial over orphan refund rows.
export async function listSalesForPosPull(tenantId, { branchId, page = 1, limit = 100 } = {}) {
  if (!branchId) {
    throw syncHttpError(422, 'branchId is required', { code: SYNC_ERROR_CODES.BRANCH_REQUIRED })
  }

  const safePage = Math.max(1, Number(page) || 1)
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100))
  const offset = (safePage - 1) * safeLimit

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM (
        SELECT s.sale_number
        FROM sales s
        WHERE s.tenant_id = $1
          AND s.branch_id = $2
          AND s.sale_number IS NOT NULL
          AND NOT (
            s.status = 'refunded'
            AND EXISTS (
              SELECT 1
              FROM sales sibling
              WHERE sibling.tenant_id = s.tenant_id
                AND sibling.branch_id = s.branch_id
                AND sibling.sale_number = s.sale_number
                AND sibling.id <> s.id
                AND sibling.status IN ('completed', 'partial_refund')
            )
          )
        GROUP BY s.sale_number
      ) t
    `,
    [branchId],
  )
  const total = countRows[0]?.total || 0

  const { rows: saleRows } = await tenantQuery(
    tenantId,
    `
      WITH ranked AS (
        SELECT
          s.id,
          s.sale_number AS "saleNumber",
          s.status,
          s.invoice_type AS "invoiceType",
          s.sold_at AS "soldAt",
          s.subtotal,
          s.tax_amount AS "taxAmount",
          s.discount_amount AS "discountAmount",
          s.final_amount AS "finalAmount",
          s.paid_amount AS "paidAmount",
          s.return_amount AS "returnAmount",
          s.original_sale_number AS "originalSaleNumber",
          st.user_id AS "cashierUserId",
          ROW_NUMBER() OVER (
            PARTITION BY s.sale_number
            ORDER BY
              CASE
                WHEN s.status IN ('completed', 'partial_refund') THEN 0
                WHEN s.invoice_type = 'exchange' THEN 0
                WHEN s.status = 'refunded' THEN 1
                ELSE 2
              END,
              s.updated_at DESC NULLS LAST,
              s.created_at ASC
          ) AS rn
        FROM sales s
        LEFT JOIN staff st ON st.id = s.staff_id AND st.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.branch_id = $2
          AND s.sale_number IS NOT NULL
      ),
      canonical AS (
        SELECT *
        FROM ranked
        WHERE rn = 1
          AND NOT (
            status = 'refunded'
            AND EXISTS (
              SELECT 1
              FROM sales sibling
              WHERE sibling.tenant_id = $1
                AND sibling.branch_id = $2
                AND sibling.sale_number = ranked."saleNumber"
                AND sibling.id <> ranked.id
                AND sibling.status IN ('completed', 'partial_refund')
            )
          )
      )
      SELECT *
      FROM canonical
      ORDER BY "soldAt" ASC, id ASC
      LIMIT $3 OFFSET $4
    `,
    [branchId, safeLimit, offset],
  )

  if (!saleRows.length) {
    return { items: [], total, page: safePage, limit: safeLimit }
  }

  const saleIds = saleRows.map((row) => row.id)
  const { rows: itemRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        si.sale_id AS "saleId",
        si.product_id AS "productId",
        p.item_code AS sku,
        p.name,
        si.quantity,
        si.unit_price AS "unitPrice",
        si.discount_amount AS "discount",
        si.tax_amount AS "tax",
        si.line_total AS "lineTotal",
        si.is_exchange AS "isExchange",
        si.is_returned AS "isReturned"
      FROM sale_items si
      JOIN products p ON p.id = si.product_id AND p.tenant_id = si.tenant_id
      WHERE si.tenant_id = $1
        AND si.sale_id = ANY($2::uuid[])
      ORDER BY si.created_at ASC
    `,
    [saleIds],
  )

  const itemsBySale = new Map()
  for (const item of itemRows) {
    const list = itemsBySale.get(item.saleId) || []
    list.push({
      productId: item.productId,
      sku: item.sku || null,
      name: item.name || null,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      tax: Number(item.tax),
      lineTotal: Number(item.lineTotal),
      isExchange: Boolean(item.isExchange),
      isReturned: Boolean(item.isReturned),
    })
    itemsBySale.set(item.saleId, list)
  }

  const items = saleRows.map((row) => {
    const type = mapPosInvoiceType(row)
    return {
      saleId: row.id,
      saleNumber: row.saleNumber,
      status: row.status,
      type,
      paymentStatus: mapPosPaymentStatus(type),
      soldAt: row.soldAt,
      cashierUserId: row.cashierUserId || null,
      subtotal: Number(row.subtotal),
      tax: Number(row.taxAmount),
      discount: Number(row.discountAmount),
      total: Number(row.finalAmount),
      paidAmount: Number(row.paidAmount),
      returnAmount: Number(row.returnAmount),
      originalSaleNumber: row.originalSaleNumber || null,
      items: itemsBySale.get(row.id) || [],
    }
  })

  return { items, total, page: safePage, limit: safeLimit }
}

// ---------------------------------------------------------------------------
// Bootstrap / Delta snapshots
// ---------------------------------------------------------------------------

// Branch BM + cashier for POS offline login (bcrypt hash included).
// Always send the full BM/cashier set (active + inactive) so POS can upsert isActive=false
// after a branch block / staff deactivate on the next successful sync.
async function fetchBootstrapUsers(tenantId, branchId, _since = null) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        u.id,
        u.email AS "loginId",
        r.slug AS role,
        u.full_name AS "fullName",
        u.branch_id AS "branchId",
        u.tenant_id AS "tenantId",
        u.is_active AS "isActive",
        u.password_hash AS "passwordHash"
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id = $1
        AND u.branch_id = $2
        AND r.slug IN ($3, $4)
      ORDER BY u.full_name
    `,
    [branchId, ROLES.BRANCH_MANAGER, ROLES.CASHIER],
  )
  return rows
}

async function fetchBootstrapCategories(tenantId, branchId, since = null) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        parent_id AS "parentId",
        name,
        image_url AS "imageUrl",
        is_active AS "isActive",
        branch_id AS "branchId"
      FROM categories
      WHERE tenant_id = $1
        AND branch_id = $2
        AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
        AND ($3::timestamptz IS NOT NULL OR is_active = true)
      ORDER BY name
    `,
    [branchId, since],
  )
  return rows.map((row) => ({
    ...row,
    imageUrl: normalizeImageUrl(row.imageUrl),
  }))
}

async function fetchBootstrapProducts(tenantId, branchId, since = null) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        p.id,
        p.name,
        p.item_code AS "itemCode",
        p.barcode,
        p.type,
        p.scale,
        p.selling_price AS "sellingPrice",
        COALESCE(p.price_currency, 'PKR') AS "priceCurrency",
        p.discount_percent AS "discountPercent",
        p.status,
        -- POS: variant SKUs inherit parent product image when child has none
        COALESCE(
          NULLIF(trim(p.image_url), ''),
          NULLIF(trim(parent.image_url), '')
        ) AS "imageUrl",
        p.description,
        p.category_id AS "categoryId",
        p.subcategory_id AS "subcategoryId",
        p.branch_id AS "branchId",
        p.parent_id AS "parentId",
        p.variant_label AS "variantLabel",
        p.offer_id AS "offerId",
        p.updated_at AS "updatedAt"
      FROM products p
      LEFT JOIN products parent
        ON parent.id = p.parent_id AND parent.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1
        AND p.branch_id = $2
        AND (
          $3::timestamptz IS NULL
          OR p.created_at > $3::timestamptz
          OR p.updated_at > $3::timestamptz
        )
        AND ($3::timestamptz IS NOT NULL OR p.status = 'active')
      ORDER BY p.name
    `,
    [branchId, since],
  )
  return rows.map((row) => ({
    ...row,
    imageUrl: normalizeImageUrl(row.imageUrl),
  }))
}

async function fetchProductTaxMap(tenantId, productIds) {
  if (!productIds.length) return new Map()
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT product_id AS "productId", tax_id AS "taxId"
      FROM product_taxes
      WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
    `,
    [productIds],
  )
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.productId)) map.set(row.productId, [])
    map.get(row.productId).push(row.taxId)
  }
  return map
}

async function fetchBundleItemsMap(tenantId, bundleIds) {
  if (!bundleIds.length) return new Map()
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        bundle_id AS "bundleId",
        item_id AS "itemId",
        quantity
      FROM bundle_items
      WHERE tenant_id = $1 AND bundle_id = ANY($2::uuid[])
    `,
    [bundleIds],
  )
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.bundleId)) map.set(row.bundleId, [])
    map.get(row.bundleId).push({ itemId: row.itemId, quantity: Number(row.quantity) })
  }
  return map
}

// Variant child SKUs: combination parts from product_variant_options (POS catalog).
async function fetchProductVariantOptionsMap(tenantId, productIds) {
  if (!productIds.length) return new Map()

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        product_id AS "productId",
        sort_order AS "sortOrder",
        type_name AS "typeName",
        value_name AS "valueName",
        is_custom_type AS "isCustomType",
        is_custom_value AS "isCustomValue"
      FROM product_variant_options
      WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
      ORDER BY product_id, sort_order ASC
    `,
    [productIds],
  )

  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.productId)) map.set(row.productId, [])
    map.get(row.productId).push({
      typeName: row.typeName,
      valueName: row.valueName,
      sortOrder: row.sortOrder,
      isCustomType: row.isCustomType,
      isCustomValue: row.isCustomValue,
    })
  }
  return map
}

async function attachProductExtras(tenantId, products) {
  const productIds = products.map((p) => p.id)
  const bundleIds = products.filter((p) => p.type === 'bundle').map((p) => p.id)
  const [taxMap, bundleMap, variantOptionsMap] = await Promise.all([
    fetchProductTaxMap(tenantId, productIds),
    fetchBundleItemsMap(tenantId, bundleIds),
    fetchProductVariantOptionsMap(tenantId, productIds),
  ])

  return products.map((p) => ({
    ...p,
    taxIds: taxMap.get(p.id) || [],
    bundleItems: bundleMap.get(p.id) || [],
    variantOptions: variantOptionsMap.get(p.id) || [],
  }))
}

async function fetchTaxes(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, name, rate_percent AS "ratePercent" FROM taxes WHERE tenant_id = $1 ORDER BY name`,
  )
  return rows
}

async function fetchOffers(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT id, name, percent FROM offers WHERE tenant_id = $1 ORDER BY name`,
  )
  return rows
}

async function fetchBranchInventory(tenantId, branchId, since = null) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT product_id AS "productId", quantity
      FROM branch_inventory
      WHERE tenant_id = $1
        AND branch_id = $2
        AND ($3::timestamptz IS NULL OR updated_at > $3::timestamptz)
      ORDER BY product_id
    `,
    [branchId, since],
  )
  return rows
}

async function fetchCounters(tenantId, branchId, since = null) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT id, code, name, is_active AS "isActive"
      FROM pos_counters
      WHERE tenant_id = $1
        AND branch_id = $2
        AND is_active = true
        AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
      ORDER BY code
    `,
    [branchId, since],
  )
  return rows
}

async function fetchTenantBranchMeta(tenantId, branchId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        t.id AS "tenantId",
        t.name AS "tenantName",
        t.slug AS "tenantSlug",
        t.contact_numbers AS "contactNumbers",
        t.business_address AS "businessAddress",
        COALESCE(t.default_currency, 'PKR') AS "defaultCurrency",
        b.id AS "branchId",
        b.name AS "branchName",
        b.status AS "branchStatus"
      FROM tenants t
      JOIN branches b ON b.tenant_id = t.id AND b.id = $2
      WHERE t.id = $1
      LIMIT 1
    `,
    [branchId],
  )
  return rows[0] || null
}

// ---------------------------------------------------------------------------
// Admin policies → POS invoice slip (FluxOne-POS consume contract)
// Enabled policies only (print_on_slip = true). Helpers:
//   posSlipPolicies.contract.js → resolveSlipPoliciesForPrint / formatSlipPolicyPrintLines
// POS must print company.slipPolicies on each sale receipt; see that file when
// implementing FluxOne-POS printer UI.
// ---------------------------------------------------------------------------
async function fetchSlipPolicies(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        name,
        detail,
        category,
        print_on_slip AS "printOnSlip"
      FROM policies
      WHERE tenant_id = $1
        AND is_active = true
        AND print_on_slip = true
      ORDER BY name ASC
    `,
  )
  return rows.map((row) => ({
    id: row.id,
    name: row.name || '',
    detail: row.detail || '',
    category: row.category || null,
    printOnSlip: true,
    // Alias for TL "Enabled" wording on POS if needed
    enabled: true,
  }))
}

function buildCompanyPayload(meta, slipPolicies = []) {
  // Flat text for simple / legacy thermal printers
  const returnInstructions =
    slipPolicies.length > 0
      ? slipPolicies.map((p) => `${p.name}: ${p.detail}`).join('\n\n')
      : null
  const warningMessage =
    slipPolicies.length > 0 ? slipPolicies.map((p) => p.name).join(' · ') : null

  return {
    name: meta.tenantName,
    contactPhone: meta.contactNumbers || null,
    phone: meta.contactNumbers || null,
    address: meta.businessAddress || null,
    currency: meta.defaultCurrency || 'PKR',
    warningMessage,
    returnInstructions,
    // Structured list — preferred source for FluxOne-POS receipt footer
    slipPolicies,
  }
}

async function buildSnapshotSections(tenantId, branchId, since = null) {
  const [users, categories, rawProducts, branchInventory, counters, taxes, offers, slipPolicies] =
    await Promise.all([
      fetchBootstrapUsers(tenantId, branchId, since),
      fetchBootstrapCategories(tenantId, branchId, since),
      fetchBootstrapProducts(tenantId, branchId, since),
      fetchBranchInventory(tenantId, branchId, since),
      fetchCounters(tenantId, branchId, since),
      fetchTaxes(tenantId),
      fetchOffers(tenantId),
      fetchSlipPolicies(tenantId),
    ])

  const products = await attachProductExtras(tenantId, rawProducts)

  return {
    users,
    categories,
    products,
    taxes,
    offers,
    branchInventory,
    counters,
    // Only Admin-Enabled policies (print_on_slip) — POS prints these on sale slips
    policies: slipPolicies,
  }
}

export async function buildBootstrapSnapshot(tenantId, branchId) {
  const meta = await fetchTenantBranchMeta(tenantId, branchId)
  if (!meta) {
    throw syncHttpError(404, 'Branch not found', { code: SYNC_ERROR_CODES.BRANCH_NOT_FOUND })
  }

  const sections = await buildSnapshotSections(tenantId, branchId, null)

  return {
    syncVersion: new Date().toISOString(),
    tenant: { id: meta.tenantId, name: meta.tenantName, slug: meta.tenantSlug },
    branch: {
      id: meta.branchId,
      name: meta.branchName,
      status: meta.branchStatus || 'open',
    },
    ...sections,
    company: buildCompanyPayload(meta, sections.policies || []),
  }
}

export async function buildDeltaSnapshot(tenantId, branchId, since) {
  const meta = await fetchTenantBranchMeta(tenantId, branchId)
  if (!meta) {
    throw syncHttpError(404, 'Branch not found', { code: SYNC_ERROR_CODES.BRANCH_NOT_FOUND })
  }

  const sections = await buildSnapshotSections(tenantId, branchId, since)

  return {
    syncVersion: new Date().toISOString(),
    tenant: { id: meta.tenantId, name: meta.tenantName, slug: meta.tenantSlug },
    branch: {
      id: meta.branchId,
      name: meta.branchName,
      status: meta.branchStatus || 'open',
    },
    ...sections,
    company: buildCompanyPayload(meta, sections.policies || []),
  }
}
