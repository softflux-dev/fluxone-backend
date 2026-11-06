// sync.validator.js — Zod schemas + POS payload normalizers for /api/sync.
// Purpose: validate push body, bootstrap/delta/sales queries, and per-event payloads.
// Also strips null quirks and maps alternate POS field names before model ingest.
// Read next: sync.controller.js (parseSchemaOrThrow), sync.model.js (validate* helpers).

import { z } from 'zod'
import { SALE_STATUS } from '../../config/constants.js'

// Accept demo/seed UUID-shaped ids (Zod 4 z.uuid() is RFC-4122 strict).
const idSchema = z.guid()
const GUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function isGuid(value) {
  return typeof value === 'string' && GUID_RE.test(value)
}

// POS JSON often uses null for "unset"; Zod .optional() only allows undefined
function stripNullFields(value) {
  if (Array.isArray(value)) {
    return value.map(stripNullFields)
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      if (nested === null) continue
      out[key] = stripNullFields(nested)
    }
    return out
  }
  return value
}

// Optional string that accepts null/undefined (after normalize, null should already be gone)
const optionalString = z.string().nullish()
const optionalGuid = idSchema.nullish()

export function formatZodIssues(error) {
  return (
    error?.issues
      ?.map((issue) => `${issue.path?.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ') || 'Validation failed'
  )
}

export function zodErrorDetails(error) {
  const flattened = error?.flatten?.() || { formErrors: [], fieldErrors: {} }
  return {
    formErrors: flattened.formErrors,
    fieldErrors: flattened.fieldErrors,
    issues: (error?.issues || []).map((issue) => ({
      path: issue.path?.join('.') || '',
      message: issue.message,
      code: issue.code,
    })),
  }
}

export const saleLineSchema = z.object({
  productId: idSchema,
  quantity: z.coerce.number().positive(),
  scale: z.coerce.string().min(1).nullish(),
  unitPrice: z.coerce.number().nonnegative().nullish(),
  discountAmount: z.coerce.number().nonnegative().nullish(),
  taxAmount: z.coerce.number().nonnegative().nullish(),
  lineTotal: z.coerce.number().nonnegative().nullish(),
  isExchange: z.boolean().nullish(),
  isReturned: z.boolean().nullish(),
})

export const salePayloadSchema = z.object({
  localSaleId: optionalString,
  saleNumber: optionalString,
  soldAt: optionalString,
  // POS may send counterCode: null when no till is selected
  counterCode: optionalString,
  staffUserId: optionalGuid,
  paymentMethod: optionalString,
  subtotal: z.coerce.number().nonnegative().nullish(),
  taxAmount: z.coerce.number().nonnegative().nullish(),
  discountAmount: z.coerce.number().nonnegative().nullish(),
  finalAmount: z.coerce.number().nonnegative().nullish(),
  paidAmount: z.coerce.number().nonnegative().nullish(),
  returnAmount: z.coerce.number().nonnegative().nullish(),
  originalInvoiceId: optionalString,
  // POS exchange sale leg: same invoiceId, received lines + stock OUT
  exchange: z.boolean().nullish(),
  status: z
    .enum([
      SALE_STATUS.COMPLETED,
      SALE_STATUS.REFUNDED,
      SALE_STATUS.PARTIAL_REFUND,
      SALE_STATUS.VOID,
    ])
    .nullish(),
  lines: z.array(saleLineSchema).min(1),
  reason: optionalString,
})

export const salesPullQuerySchema = z.object({
  branchId: idSchema,
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(200).optional().default(100),
})

export const productPricePayloadSchema = z.object({
  productId: idSchema,
  sellingPrice: z.coerce.number().nonnegative(),
  discountPercent: z.coerce.number().min(0).max(100).nullish(),
  branchId: optionalGuid,
  currency: optionalString,
  updatedAt: optionalString,
  updatedByUserId: optionalGuid,
  source: optionalString,
  deviceId: optionalString,
})

/** Known POS cashier_log action slugs (others still accepted as free-form strings). */
export const CASHIER_LOG_ACTIONS = [
  'login',
  'logout',
  'open_cash_drawer',
  'close_cash_drawer',
  'price_change',
  'change_cashier',
]

export const cashierLogPayloadSchema = z.object({
  action: z.string().min(1),
  actorName: z.string().min(1),
  actorUserId: optionalGuid,
  actorRole: optionalString,
  // POS employee uuid — not cloud users.id; stored in activity details for traceability
  employeeId: optionalString,
  entityType: optionalString,
  entityId: optionalString,
  metadata: z.record(z.string(), z.any()).nullish(),
  timestamp: z.string().min(1),
  branchId: optionalGuid,
  deviceId: optionalString,
})

// POS sync event type slugs (kept as a plain array for z.enum).
export const SYNC_EVENT_TYPES = [
  'sale',
  'refund',
  'cashier_log',
  'attendance',
  'product_price_update',
  'price_change',
]

export const syncEventSchema = z.object({
  clientEventId: z.string().min(1),
  eventType: z.enum(SYNC_EVENT_TYPES),
  payload: z.record(z.string(), z.any()),
  deviceId: optionalString,
})

// Cap batch size so a single push cannot overload ingest / DB.
export const SYNC_PUSH_MAX_EVENTS = 200

export const pushBodySchema = z.object({
  deviceId: optionalString,
  branchId: optionalGuid,
  events: z.array(syncEventSchema).min(1).max(SYNC_PUSH_MAX_EVENTS),
})

export const bootstrapQuerySchema = z.object({
  branchId: idSchema,
})

export const deltaQuerySchema = z.object({
  branchId: idSchema,
  since: z.string().min(1),
})

// Map POS field names to cloud schema before validation
export function normalizePosSalePayload(raw = {}) {
  // Drop nulls so counterCode/cashierName/etc. do not fail Zod
  const payload = stripNullFields({ ...raw })

  // Prefer non-empty lines; fall back to POS alias `items`
  const rawLines = Array.isArray(raw.lines) ? raw.lines : null
  const rawItems = Array.isArray(raw.items) ? raw.items : null
  if ((!rawLines || rawLines.length === 0) && rawItems && rawItems.length > 0) {
    payload.lines = stripNullFields(rawItems)
  } else if (rawLines) {
    payload.lines = stripNullFields(rawLines)
  } else if (rawItems) {
    payload.lines = stripNullFields(rawItems)
  }

  const staffCandidate = payload.staffUserId ?? raw.cashierId ?? raw.cashier_id
  if (staffCandidate != null && payload.staffUserId == null) {
    payload.staffUserId = staffCandidate
  }
  // Non-UUID cashier/local ids must not fail the whole sale — staff is optional
  if (payload.staffUserId != null && !isGuid(String(payload.staffUserId))) {
    delete payload.staffUserId
  }

  if (raw.invoiceId && !payload.saleNumber) {
    payload.saleNumber = raw.invoiceId
  }

  if (raw.exchange === true || raw.isExchange === true) {
    payload.exchange = true
  }

  if (raw.originalInvoiceId && !payload.originalInvoiceId) {
    payload.originalInvoiceId = raw.originalInvoiceId
  }
  if (raw.originalSaleNumber && !payload.originalInvoiceId) {
    payload.originalInvoiceId = raw.originalSaleNumber
  }

  if (raw.discount !== undefined && raw.discount !== null && payload.discountAmount === undefined) {
    payload.discountAmount = raw.discount
  }
  if (raw.tax !== undefined && raw.tax !== null && payload.taxAmount === undefined) {
    payload.taxAmount = raw.tax
  }
  if (payload.finalAmount === undefined && raw.total !== undefined && raw.total !== null) {
    payload.finalAmount = raw.total
  }
  if (payload.paidAmount === undefined && raw.tendered !== undefined && raw.tendered !== null) {
    payload.paidAmount = raw.tendered
  }
  if (raw.changeDue !== undefined && raw.changeDue !== null && payload.returnAmount === undefined) {
    payload.returnAmount = raw.changeDue
  }

  if (raw.refundAmount !== undefined && raw.refundAmount !== null && payload.finalAmount === undefined) {
    payload.finalAmount = raw.refundAmount
  }

  if (Array.isArray(payload.lines)) {
    payload.lines = payload.lines.map((line) => ({
      ...line,
      productId: line.productId ?? line.product_id,
      discountAmount: line.discountAmount ?? line.discount,
      taxAmount: line.taxAmount ?? line.tax,
      // Coerce numeric scale from POS (e.g. 1) to string
      scale: line.scale != null && line.scale !== '' ? String(line.scale) : undefined,
      isExchange: line.isExchange ?? line.is_exchange ?? false,
      isReturned: line.isReturned ?? line.is_returned ?? false,
    }))
  }

  return payload
}

// Normalize POS Items Rate / price push aliases
export function normalizePosPricePayload(raw = {}) {
  const payload = stripNullFields({ ...raw })

  const productId = raw.productId ?? raw.product_id ?? raw.id
  if (productId && !payload.productId) payload.productId = productId

  const sellingPrice = raw.sellingPrice ?? raw.selling_price ?? raw.price
  if (sellingPrice !== undefined && sellingPrice !== null && payload.sellingPrice === undefined) {
    payload.sellingPrice = sellingPrice
  }

  const discountPercent = raw.discountPercent ?? raw.discount_percent ?? raw.discount
  if (discountPercent !== undefined && discountPercent !== null && payload.discountPercent === undefined) {
    payload.discountPercent = discountPercent
  }

  const branchId = raw.branchId ?? raw.branch_id
  if (branchId && !payload.branchId) payload.branchId = branchId

  const updatedAt = raw.updatedAt ?? raw.updated_at
  if (updatedAt && !payload.updatedAt) payload.updatedAt = updatedAt

  const updatedByUserId = raw.updatedByUserId ?? raw.updated_by_user_id
  if (updatedByUserId && !payload.updatedByUserId) payload.updatedByUserId = updatedByUserId

  return payload
}

// Normalize POS cashier_log aliases (camelCase primary; snake_case accepted)
export function normalizePosCashierLogPayload(raw = {}) {
  const payload = stripNullFields({ ...raw })

  const action = raw.action ?? raw.event_action
  if (action && !payload.action) payload.action = action

  const actorName = raw.actorName ?? raw.actor_name ?? raw.cashierName ?? raw.cashier_name
  if (actorName && !payload.actorName) payload.actorName = actorName

  const actorUserId = raw.actorUserId ?? raw.actor_user_id
  if (actorUserId != null && payload.actorUserId == null) payload.actorUserId = actorUserId
  // Non-UUID cloud user ids must not fail the whole event — actor is optional for FK
  if (payload.actorUserId != null && !isGuid(String(payload.actorUserId))) {
    delete payload.actorUserId
  }

  const actorRole = raw.actorRole ?? raw.actor_role ?? raw.role
  if (actorRole && !payload.actorRole) payload.actorRole = actorRole

  const employeeId = raw.employeeId ?? raw.employee_id
  if (employeeId && !payload.employeeId) payload.employeeId = String(employeeId)

  const entityType = raw.entityType ?? raw.entity_type
  if (entityType && !payload.entityType) payload.entityType = entityType

  const entityId = raw.entityId ?? raw.entity_id
  if (entityId != null && payload.entityId == null) payload.entityId = String(entityId)

  const timestamp = raw.timestamp ?? raw.createdAt ?? raw.created_at
  if (timestamp && !payload.timestamp) payload.timestamp = timestamp

  const branchId = raw.branchId ?? raw.branch_id
  if (branchId && !payload.branchId) payload.branchId = branchId

  const deviceId = raw.deviceId ?? raw.device_id
  if (deviceId && !payload.deviceId) payload.deviceId = String(deviceId)

  const metadata = raw.metadata ?? raw.details
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata) && !payload.metadata) {
    payload.metadata = stripNullFields(metadata)
  }

  return payload
}

export function normalizeSyncEventPayload(eventType, payload) {
  if (eventType === 'sale' || eventType === 'refund') {
    return normalizePosSalePayload(payload)
  }
  if (eventType === 'product_price_update' || eventType === 'price_change') {
    return normalizePosPricePayload(payload)
  }
  if (eventType === 'cashier_log') {
    return normalizePosCashierLogPayload(payload)
  }
  return payload || {}
}

export function validateSalePayload(payload) {
  const normalized = normalizePosSalePayload(payload)
  return salePayloadSchema.safeParse(normalized)
}

export function validateRefundPayload(payload) {
  const normalized = normalizePosSalePayload(payload)
  const parsed = salePayloadSchema.safeParse(normalized)
  if (!parsed.success) return parsed

  const reason = String(parsed.data.reason || '').toLowerCase()
  const isExchangeGiven = reason === 'exchange_given' || reason.includes('exchange')
  if (isExchangeGiven) return parsed

  const status = parsed.data.status
  if (status && status !== SALE_STATUS.REFUNDED && status !== SALE_STATUS.PARTIAL_REFUND) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: 'custom',
          message: 'Refund events require status refunded or partial_refund',
          path: ['status'],
        },
      ]),
    }
  }
  return parsed
}

export function validateProductPricePayload(payload) {
  const normalized = normalizePosPricePayload(payload)
  return productPricePayloadSchema.safeParse(normalized)
}

export function validateCashierLogPayload(payload) {
  const normalized = normalizePosCashierLogPayload(payload)
  return cashierLogPayloadSchema.safeParse(normalized)
}

export function parseSchemaOrThrow(schema, data, label = 'Request') {
  const result = schema.safeParse(data)
  if (!result.success) {
    const details = zodErrorDetails(result.error)
    const message =
      `${label}: ${formatZodIssues(result.error)}` || `${label} validation failed`
    const err = new Error(message)
    err.status = 422
    err.code = 'VALIDATION_FAILED'
    err.retryable = false
    err.hint = 'Fix request body/query fields to match the sync contract, then retry.'
    err.fieldPaths = (details.issues || []).map((i) => i.path).filter(Boolean)
    err.details = details
    throw err
  }
  return result.data
}
