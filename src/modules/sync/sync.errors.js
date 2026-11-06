// sync.errors.js — stable error codes + rejected[] builders for POS sync.
// Purpose: shared contract for push failures and request-level sync errors.
// Shape: code, reason, retryable, hint, optional fieldPaths/details/context.
// Read next: sync.controller.js (buildRejectedPushEvent), docs/SYNC_FLOW.md.

/**
 * Sync error contract for POS ↔ cloud.
 *
 * Push rejected events and pull/request failures share:
 *   code       — stable machine key (POS switch / retry policy)
 *   reason     — human-readable message
 *   retryable  — true → backoff & retry; false → fix payload / data first
 *   hint       — short fix guidance for local DB / POS team
 *   fieldPaths — Zod paths when validation failed
 *   details    — optional structured extras (no full PII payloads)
 */

export const SYNC_ERROR_CODES = Object.freeze({
  // Request / auth / access
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BRANCH_REQUIRED: 'BRANCH_REQUIRED',
  BRANCH_ACCESS_DENIED: 'BRANCH_ACCESS_DENIED',
  BRANCH_NOT_FOUND: 'BRANCH_NOT_FOUND',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',

  // Sale / refund
  SALE_VALIDATION_FAILED: 'SALE_VALIDATION_FAILED',
  REFUND_VALIDATION_FAILED: 'REFUND_VALIDATION_FAILED',
  REFUND_MISSING_INVOICE: 'REFUND_MISSING_INVOICE',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  INSUFFICIENT_BRANCH_STOCK: 'INSUFFICIENT_BRANCH_STOCK',
  PRODUCT_INACTIVE: 'PRODUCT_INACTIVE',
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',

  // Price / logs
  PRICE_VALIDATION_FAILED: 'PRICE_VALIDATION_FAILED',
  CASHIER_LOG_VALIDATION_FAILED: 'CASHIER_LOG_VALIDATION_FAILED',

  // Infra
  SYNC_STORE_FAILED: 'SYNC_STORE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN: 'UNKNOWN',
})

/** Skip reasons returned in accepted/skipped ingest results (not rejections). */
export const SYNC_SKIP_CODES = Object.freeze({
  DUPLICATE_CLIENT_EVENT_ID: 'duplicate_client_event_id',
  SALE_NUMBER_EXISTS: 'sale_number_exists',
  STALE_POS_UPDATED_AT: 'stale_pos_updated_at',
})

const CODE_META = {
  [SYNC_ERROR_CODES.VALIDATION_FAILED]: {
    retryable: false,
    hint: 'Fix request body/query fields to match the sync contract, then retry.',
  },
  [SYNC_ERROR_CODES.BRANCH_REQUIRED]: {
    retryable: false,
    hint: 'Send branchId in the body/query, or use a JWT that includes branchId.',
  },
  [SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED]: {
    retryable: false,
    hint: 'Use the branch assigned on the token. Branch-locked roles cannot sync another branch.',
  },
  [SYNC_ERROR_CODES.BRANCH_NOT_FOUND]: {
    retryable: false,
    hint: 'Confirm branchId exists for this tenant, then re-bootstrap.',
  },
  [SYNC_ERROR_CODES.AUTH_REQUIRED]: {
    retryable: true,
    hint: 'Refresh the access token / re-login on POS, then retry sync.',
  },
  [SYNC_ERROR_CODES.PERMISSION_DENIED]: {
    retryable: false,
    hint: 'Role needs sync:push or sync:pull permission.',
  },
  [SYNC_ERROR_CODES.RATE_LIMITED]: {
    retryable: true,
    hint: 'Back off and retry after the rate-limit window.',
  },
  [SYNC_ERROR_CODES.SALE_VALIDATION_FAILED]: {
    retryable: false,
    hint: 'Check sale payload: lines/items, productId GUID, quantity > 0, field aliases.',
  },
  [SYNC_ERROR_CODES.REFUND_VALIDATION_FAILED]: {
    retryable: false,
    hint: 'Refund needs saleNumber/invoiceId and status refunded|partial_refund (unless exchange).',
  },
  [SYNC_ERROR_CODES.REFUND_MISSING_INVOICE]: {
    retryable: false,
    hint: 'Set payload.saleNumber (or invoiceId alias) to the original invoice id.',
  },
  [SYNC_ERROR_CODES.INSUFFICIENT_STOCK]: {
    retryable: false,
    hint: 'Pull bootstrap/delta inventory, reconcile stock on cloud, then retry the sale.',
  },
  [SYNC_ERROR_CODES.INSUFFICIENT_BRANCH_STOCK]: {
    retryable: false,
    hint: 'Branch inventory is short. Sync catalog/inventory from cloud and adjust stock.',
  },
  [SYNC_ERROR_CODES.PRODUCT_INACTIVE]: {
    retryable: false,
    hint: 'Product is inactive on cloud. Re-activate or remove the line, then retry.',
  },
  [SYNC_ERROR_CODES.PRODUCT_NOT_FOUND]: {
    retryable: false,
    hint: 'productId must be a cloud catalog GUID for this branch. Run bootstrap/delta first.',
  },
  [SYNC_ERROR_CODES.PRICE_VALIDATION_FAILED]: {
    retryable: false,
    hint: 'Send productId (GUID) and sellingPrice >= 0 (aliases: price, selling_price).',
  },
  [SYNC_ERROR_CODES.CASHIER_LOG_VALIDATION_FAILED]: {
    retryable: false,
    hint: 'cashier_log requires action, actorName, and timestamp.',
  },
  [SYNC_ERROR_CODES.SYNC_STORE_FAILED]: {
    retryable: true,
    hint: 'Transient store failure. Retry with the same clientEventId.',
  },
  [SYNC_ERROR_CODES.INTERNAL_ERROR]: {
    retryable: true,
    hint: 'Transient server error. Retry with backoff using the same clientEventId.',
  },
  [SYNC_ERROR_CODES.UNKNOWN]: {
    retryable: false,
    hint: 'Inspect reason/details; fix payload or contact cloud support with clientEventId.',
  },
}

export function metaForCode(code) {
  return CODE_META[code] || CODE_META[SYNC_ERROR_CODES.UNKNOWN]
}

/**
 * Create an Error with sync metadata for controller / middleware.
 */
export function syncHttpError(status, message, { code, details, hint, retryable, fieldPaths } = {}) {
  const resolvedCode = code || SYNC_ERROR_CODES.UNKNOWN
  const meta = metaForCode(resolvedCode)
  const error = new Error(message)
  error.status = status
  error.code = resolvedCode
  error.retryable = retryable ?? meta.retryable
  error.hint = hint || meta.hint
  if (fieldPaths !== undefined) error.fieldPaths = fieldPaths
  if (details !== undefined) error.details = details
  return error
}

function fieldPathsFromDetails(details) {
  if (!details) return []
  if (Array.isArray(details.fieldPaths)) return details.fieldPaths
  if (Array.isArray(details.issues)) {
    return details.issues.map((i) => i.path).filter(Boolean)
  }
  return []
}

/**
 * Map a thrown error (sync model, stock ledger, Zod, auth) → stable code.
 */
export function classifySyncError(err) {
  if (err?.code && SYNC_ERROR_CODES[err.code]) {
    return err.code
  }
  if (typeof err?.code === 'string' && Object.values(SYNC_ERROR_CODES).includes(err.code)) {
    return err.code
  }

  const status = Number(err?.status || err?.statusCode || 0)
  const message = String(err?.message || '')

  if (status === 401 || /unauthorized|token|inactive user|blocked/i.test(message)) {
    return SYNC_ERROR_CODES.AUTH_REQUIRED
  }
  if (status === 429 || /too many/i.test(message)) {
    return SYNC_ERROR_CODES.RATE_LIMITED
  }
  if (/branch access denied/i.test(message)) {
    return SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED
  }
  if (/branchId is required|require branchId/i.test(message)) {
    return SYNC_ERROR_CODES.BRANCH_REQUIRED
  }
  if (/branch not found/i.test(message)) {
    return SYNC_ERROR_CODES.BRANCH_NOT_FOUND
  }
  if (/permission|forbidden|sync:push|sync:pull/i.test(message) && status === 403) {
    return SYNC_ERROR_CODES.PERMISSION_DENIED
  }
  if (/Refund events require invoiceId|saleNumber/i.test(message)) {
    return SYNC_ERROR_CODES.REFUND_MISSING_INVOICE
  }
  if (/Refund payload validation failed|Refund events require status/i.test(message)) {
    return SYNC_ERROR_CODES.REFUND_VALIDATION_FAILED
  }
  if (/Sale payload validation failed/i.test(message)) {
    return SYNC_ERROR_CODES.SALE_VALIDATION_FAILED
  }
  if (/cashier_log/i.test(message) && /validat/i.test(message)) {
    return SYNC_ERROR_CODES.CASHIER_LOG_VALIDATION_FAILED
  }
  if (/product_price_update requires/i.test(message)) {
    return SYNC_ERROR_CODES.PRICE_VALIDATION_FAILED
  }
  if (/Insufficient stock on hand/i.test(message)) {
    return SYNC_ERROR_CODES.INSUFFICIENT_STOCK
  }
  if (/Insufficient branch stock/i.test(message)) {
    return SYNC_ERROR_CODES.INSUFFICIENT_BRANCH_STOCK
  }
  if (/inactive and cannot be used/i.test(message)) {
    return SYNC_ERROR_CODES.PRODUCT_INACTIVE
  }
  if (/Product not found/i.test(message)) {
    return SYNC_ERROR_CODES.PRODUCT_NOT_FOUND
  }
  if (/Failed to store sync event/i.test(message)) {
    return SYNC_ERROR_CODES.SYNC_STORE_FAILED
  }
  if (status >= 500) {
    return SYNC_ERROR_CODES.INTERNAL_ERROR
  }
  if (status === 422 || /validat/i.test(message)) {
    return SYNC_ERROR_CODES.VALIDATION_FAILED
  }
  return SYNC_ERROR_CODES.UNKNOWN
}

/**
 * Safe context for POS debugging (no full line PII dumps).
 */
export function buildPushEventContext(eventType, payload) {
  if (!payload || typeof payload !== 'object') {
    return { eventType }
  }

  if (eventType === 'sale' || eventType === 'refund') {
    const lines = payload.lines || payload.items
    const productIds = Array.isArray(lines)
      ? lines
          .map((l) => l?.productId ?? l?.product_id)
          .filter(Boolean)
          .slice(0, 5)
      : []
    return {
      eventType,
      saleNumber: payload.saleNumber ?? payload.invoiceId ?? null,
      lineCount: Array.isArray(lines) ? lines.length : 0,
      productIds,
      status: payload.status ?? null,
      exchange: Boolean(payload.exchange || payload.isExchange),
    }
  }

  if (eventType === 'product_price_update' || eventType === 'price_change') {
    return {
      eventType,
      productId: payload.productId ?? payload.product_id ?? payload.id ?? null,
      sellingPrice: payload.sellingPrice ?? payload.selling_price ?? payload.price ?? null,
    }
  }

  if (eventType === 'cashier_log') {
    return {
      eventType,
      action: payload.action ?? null,
      actorName: payload.actorName ?? payload.actor_name ?? null,
    }
  }

  return {
    eventType,
    keys: Object.keys(payload).slice(0, 12),
  }
}

function sanitizeClientDetails(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const out = {}
  if (raw.formErrors) out.formErrors = raw.formErrors
  if (raw.fieldErrors) out.fieldErrors = raw.fieldErrors
  if (raw.issues) out.issues = raw.issues
  // Safe business context (never echo full payload)
  for (const key of ['productId', 'quantity', 'movementType', 'saleNumber', 'branchId']) {
    if (raw[key] !== undefined) out[key] = raw[key]
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Build one rejected[] entry for POST /api/sync/push.
 */
export function buildRejectedPushEvent(event, err, payloadSummary = null) {
  const code = classifySyncError(err)
  const meta = metaForCode(code)
  const fieldPaths = err?.fieldPaths || fieldPathsFromDetails(err?.details)
  const details = sanitizeClientDetails(err?.details)

  return {
    clientEventId: event.clientEventId,
    eventType: event.eventType,
    code,
    reason: err?.message || 'Event rejected',
    retryable: err?.retryable ?? meta.retryable,
    hint: err?.hint || meta.hint,
    ...(fieldPaths.length ? { fieldPaths } : {}),
    ...(details ? { details } : {}),
    ...(payloadSummary ? { context: payloadSummary } : {}),
  }
}

/**
 * JSON extras for request-level sync failures (pull/bootstrap/body Zod).
 */
export function syncErrorResponseBody(err) {
  const code = classifySyncError(err)
  const meta = metaForCode(code)
  const fieldPaths = err?.fieldPaths || fieldPathsFromDetails(err?.details)
  const body = {
    success: false,
    data: null,
    error: err?.message || 'Request failed',
    code,
    retryable: err?.retryable ?? meta.retryable,
    hint: err?.hint || meta.hint,
  }
  if (fieldPaths.length) body.fieldPaths = fieldPaths
  if (err?.details) {
    body.details = {
      formErrors: err.details.formErrors,
      fieldErrors: err.details.fieldErrors,
      issues: err.details.issues,
    }
  }
  return body
}
