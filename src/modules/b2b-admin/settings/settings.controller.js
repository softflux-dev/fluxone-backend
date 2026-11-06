import {
  getCurrencySettings,
  listDevices,
  updateCurrencySettings,
  updateDeviceStatus,
} from './settings.model.js'
import { fail, success, failFromError } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

export async function devicesList(req, res) {
  const result = await listDevices(req.tenantId, req.validated.query)
  return success(res, {
    ...paginatedResult(result.items, result),
    stats: {
      total: result.registered ?? result.total,
      active: result.active,
      blocked: result.blocked,
    },
  })
}

export async function patchDeviceStatus(req, res) {
  try {
    const row = await updateDeviceStatus(
      req.tenantId,
      req.validated.params.id,
      req.validated.body.status,
    )
    const deviceLabel = row?.name || row?.code || req.validated.params.id
    await writeAdminActivity(req.tenantId, {
      branchId: row?.branchId || req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'hardware',
      action: 'device_status',
      entityType: 'hardware',
      entityId: req.validated.params.id,
      actionText: `Changed status of device "${deviceLabel}" to ${req.validated.body.status}.`,
      affectedItem: deviceLabel,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function currencyGet(req, res) {
  const data = await getCurrencySettings(req.tenantId)
  return success(res, data)
}

export async function currencyPatch(req, res) {
  try {
    const data = await updateCurrencySettings(
      req.tenantId,
      {
        defaultCurrency: req.validated.body.defaultCurrency,
        rateToPkr: req.validated.body.rateToPkr,
      },
      req.user?.id || null,
    )
    await writeAdminActivity(req.tenantId, {
      branchId: req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'currency_settings',
      entityType: 'tenant',
      entityId: req.tenantId,
      actionText: `Updated currency settings to ${data.defaultCurrency || req.validated.body.defaultCurrency}.`,
      affectedItem: 'Currency',
    })
    return success(res, data)
  } catch (err) {
    return failFromError(res, err)
  }
}
