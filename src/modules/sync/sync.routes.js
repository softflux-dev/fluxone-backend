// sync.routes.js — Express paths + permissions for /api/sync.
// Purpose: map HTTP verbs to controller handlers; enforce sync:push / sync:pull.
// Flow: app.js mounts this after authMiddleware + syncLimiter.
// Read next: sync.controller.js — then docs/SYNC_FLOW.md for junior overview.
// Do not split this file; do not change /pull behavior (legacy compatibility).

import { Router } from 'express'
import { bootstrap, delta, events, pull, push, sales } from './sync.controller.js'
import { asyncHandler } from '../../middlewares/error.middleware.js'
import { requirePermission } from '../../middlewares/role.middleware.js'

const router = Router()

router.post('/push', requirePermission('sync:push'), asyncHandler(push))
router.get('/bootstrap', requirePermission('sync:pull'), asyncHandler(bootstrap))
router.get('/delta', requirePermission('sync:pull'), asyncHandler(delta))
router.get('/sales', requirePermission('sync:pull'), asyncHandler(sales))
router.get('/events', requirePermission('sync:pull'), asyncHandler(events))
// Legacy: GET /pull — prefer /bootstrap + /delta for POS catalog. Behavior unchanged.
// @deprecated Prefer /bootstrap and /delta for POS. Kept for backward compatibility.
router.get('/pull', requirePermission('sync:pull'), asyncHandler(pull))

export default router
