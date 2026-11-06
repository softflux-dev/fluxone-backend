import { listAdminActivityLogs } from './logs.model.js'
import {
  listAdminLogActors,
  listAdminLogFilterBundles,
  listAdminLogFilterProducts,
  listAdminLogFilterSuppliers,
  listAdminLogFilterVariantTypes,
} from './logs.filterOptions.model.js'
import { success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'

export async function adminLogsList(req, res) {
  const result = await listAdminActivityLogs(req.tenantId, req.validated.query)
  return success(res, paginatedResult(result.items, result))
}

export async function adminLogActors(req, res) {
  const { branchId, actorRole } = req.validated.query
  const items = await listAdminLogActors(req.tenantId, { branchId, actorRole })
  return success(res, { items })
}

export async function adminLogFilterOptions(req, res) {
  const { branchId, kind, productType } = req.validated.query
  let items = []
  if (kind === 'products') {
    items = await listAdminLogFilterProducts(req.tenantId, { branchId, productType })
  } else if (kind === 'bundles') {
    items = await listAdminLogFilterBundles(req.tenantId, { branchId })
  } else if (kind === 'suppliers') {
    items = await listAdminLogFilterSuppliers(req.tenantId, { branchId })
  } else if (kind === 'variant_types') {
    items = await listAdminLogFilterVariantTypes(req.tenantId, { branchId })
  }
  return success(res, { items })
}
