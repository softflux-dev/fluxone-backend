import {
  listNotifications,
  countUnreadNotifications,
  getNotificationById,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from './notifications.model.js'
import { success, fail } from '../../utils/response.util.js'

export async function notificationsList(req, res) {
  const unreadOnly = String(req.query?.unreadOnly || '') === 'true'
  const limit = Math.min(Number(req.query?.limit) || 50, 100)
  const offset = Math.max(Number(req.query?.offset) || 0, 0)

  const [items, unreadCount] = await Promise.all([
    listNotifications(req.tenantId, {
      recipientUserId: req.user.id,
      unreadOnly,
      limit,
      offset,
    }),
    countUnreadNotifications(req.tenantId, req.user.id),
  ])

  return success(res, { items, unreadCount })
}

export async function notificationsUnreadCount(req, res) {
  const unreadCount = await countUnreadNotifications(req.tenantId, req.user.id)
  return success(res, { unreadCount })
}

export async function notificationMarkRead(req, res) {
  const row = await markNotificationRead(req.tenantId, req.params.id, req.user.id)
  if (!row) return fail(res, 'Notification not found', 404)
  return success(res, row)
}

export async function notificationMarkAllRead(req, res) {
  const updated = await markAllNotificationsRead(req.tenantId, req.user.id)
  return success(res, { updated })
}

export async function notificationRemove(req, res) {
  const existing = await getNotificationById(req.tenantId, req.params.id, req.user.id)
  if (!existing) return fail(res, 'Notification not found', 404)
  await deleteNotification(req.tenantId, req.params.id, req.user.id)
  return success(res, { id: req.params.id })
}
