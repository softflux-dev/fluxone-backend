// sync.controller.js — HTTP handlers for POS sync endpoints.
// Purpose: validate input, resolve branch access, call model, return { success, data }.
// Push always responds 202 when the outer body is valid — check data.rejected[].
// Read next: sync.model.js (SQL/ingest), sync.access.js (branch lock), docs/SYNC_FLOW.md.
// /pull is legacy and must keep current behavior (delegates like events today).

import {
  buildBootstrapSnapshot,
  buildDeltaSnapshot,
  ingestSyncEvent,
  listSalesForPosPull,
  listSyncEvents,
} from './sync.model.js'
import {
  bootstrapQuerySchema,
  deltaQuerySchema,
  normalizeSyncEventPayload,
  parseSchemaOrThrow,
  pushBodySchema,
  salesPullQuerySchema,
} from './sync.validator.js'
import {
  resolveSyncEventsBranchFilter,
  resolveSyncPullBranchId,
  resolveSyncPushBranchId,
} from './sync.access.js'
import {
  buildPushEventContext,
  buildRejectedPushEvent,
} from './sync.errors.js'
import { mapSnapshotForPos } from './sync.mapper.js'
import { success } from '../../utils/response.util.js'
import { paginatedResult } from '../../utils/pagination.util.js'

/**
 * POST /api/sync/push
 *
 * Always HTTP 202 when the outer body is valid. POS must inspect:
 *   data.hasFailures, data.rejected[], data.accepted[]
 *
 * Each rejected item includes: code, reason, retryable, hint, fieldPaths?, details?, context?
 */
export async function push(req, res) {
  const parsed = parseSchemaOrThrow(pushBodySchema, req.body, 'Push body')
  const branchId = resolveSyncPushBranchId(req, parsed.branchId)

  const accepted = []
  const rejected = []
  const skipped = []
  const events = []

  for (const event of parsed.events) {
    const normalized = {
      ...event,
      deviceId: event.deviceId || parsed.deviceId || null,
      payload: normalizeSyncEventPayload(event.eventType, event.payload),
    }
    const context = buildPushEventContext(event.eventType, normalized.payload)

    try {
      const row = await ingestSyncEvent(
        req.tenantId,
        {
          ...normalized,
          branchId,
          syncedBy: req.user.id,
        },
        req.user.id,
      )
      events.push(row)
      accepted.push(row.clientEventId)
      if (row.skipped) {
        skipped.push({
          clientEventId: row.clientEventId,
          eventType: event.eventType,
          reason: row.reason || 'skipped',
          code: row.code || row.reason || 'skipped',
          retryable: row.retryable ?? false,
          hint:
            row.hint ||
            'Event was idempotently skipped. Mark as synced locally; do not treat as a hard failure.',
          context,
        })
      }
    } catch (err) {
      const rejectedItem = buildRejectedPushEvent(event, err, context)
      console.error('[sync/push] event rejected', {
        clientEventId: rejectedItem.clientEventId,
        eventType: rejectedItem.eventType,
        code: rejectedItem.code,
        reason: rejectedItem.reason,
        retryable: rejectedItem.retryable,
        fieldPaths: rejectedItem.fieldPaths || null,
        context,
      })
      rejected.push(rejectedItem)
    }
  }

  const acceptedCount = accepted.length
  const rejectedCount = rejected.length
  const hasFailures = rejectedCount > 0

  return success(
    res,
    {
      accepted,
      rejected,
      skipped,
      events,
      acceptedCount,
      rejectedCount,
      skippedCount: skipped.length,
      hasFailures,
      // POS guidance: 202 alone is not success for every event
      message: hasFailures
        ? `${rejectedCount} of ${parsed.events.length} event(s) rejected — see rejected[].code / hint`
        : `All ${acceptedCount} event(s) accepted`,
    },
    202,
  )
}

export async function bootstrap(req, res) {
  const { branchId } = parseSchemaOrThrow(bootstrapQuerySchema, req.query, 'Bootstrap query')
  const resolvedBranchId = resolveSyncPullBranchId(req, branchId)
  const snapshot = await buildBootstrapSnapshot(req.tenantId, resolvedBranchId)
  return success(res, mapSnapshotForPos(snapshot))
}

export async function delta(req, res) {
  const { branchId, since } = parseSchemaOrThrow(deltaQuerySchema, req.query, 'Delta query')
  const resolvedBranchId = resolveSyncPullBranchId(req, branchId)
  const snapshot = await buildDeltaSnapshot(req.tenantId, resolvedBranchId, since)
  return success(res, mapSnapshotForPos(snapshot))
}

// Cloud → POS invoice history (paginated, current state per saleNumber).
export async function sales(req, res) {
  const query = parseSchemaOrThrow(salesPullQuerySchema, req.query, 'Sales pull query')
  const branchId = resolveSyncPullBranchId(req, query.branchId)
  const result = await listSalesForPosPull(req.tenantId, {
    branchId,
    page: query.page,
    limit: query.limit,
  })
  return success(res, paginatedResult(result.items, result))
}

// Cloud pos_sync_events audit log — not POS catalog.
export async function events(req, res) {
  const branchId = resolveSyncEventsBranchFilter(req, req.query.branchId)
  const rows = await listSyncEvents(req.tenantId, {
    since: req.query.since,
    branchId,
  })
  return success(res, rows)
}

// @deprecated Use GET /api/sync/bootstrap and /api/sync/delta for POS catalog sync.
export async function pull(req, res) {
  return events(req, res)
}
