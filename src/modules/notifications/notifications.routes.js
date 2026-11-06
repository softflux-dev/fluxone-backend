import { Router } from 'express'
import { asyncHandler } from '../../middlewares/error.middleware.js'
import { validate } from '../../middlewares/validate.middleware.js'
import {
  notificationsList,
  notificationsUnreadCount,
  notificationMarkRead,
  notificationMarkAllRead,
  notificationRemove,
} from './notifications.controller.js'
import { listNotificationsSchema, notificationIdSchema } from './notifications.validator.js'

const router = Router()

// Authenticated user — only their own notifications
router.get('/', validate(listNotificationsSchema), asyncHandler(notificationsList))
router.get('/unread-count', asyncHandler(notificationsUnreadCount))
router.patch('/read-all', asyncHandler(notificationMarkAllRead))
router.patch('/:id/read', validate(notificationIdSchema), asyncHandler(notificationMarkRead))
router.delete('/:id', validate(notificationIdSchema), asyncHandler(notificationRemove))

export default router
