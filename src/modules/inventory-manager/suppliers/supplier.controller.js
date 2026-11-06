import {
  createSupplier,
  deleteSupplier,
  listSuppliers,
  setSupplierActive,
  updateSupplier,
} from './supplier.model.js'
import { resolveInventoryCreateScope, resolveInventoryScope } from '../shared.access.js'
import { fail, failFromError, success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import { resolveUploadUrl } from '../../../utils/uploadUrl.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

function fileUrl(file, req) {
  return resolveUploadUrl(file, req)
}

// Only return keys for files that were actually uploaded — never null-out the other field.
// Bug: always returning imageUrl/signatureUrl: null wiped company image when only signature changed (and vice versa).
function filesFromRequest(req) {
  const out = {}
  const imageFile = req.files?.image?.[0] || req.file || null
  const signatureFile = req.files?.signature?.[0] || null
  if (imageFile) out.imageUrl = fileUrl(imageFile, req)
  if (signatureFile) out.signatureUrl = fileUrl(signatureFile, req)
  return out
}


export async function list(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const result = await listSuppliers(tenantId, { ...req.validated.query, branchId })
    return success(res, paginatedResult(result.items, result))
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function create(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryCreateScope(req)
    const row = await createSupplier(tenantId, {
      ...req.validated.body,
      ...filesFromRequest(req),
      branchId,
    })
    await writeAdminActivity(tenantId, {
      branchId: row.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'orders_suppliers',
      action: 'supplier_create',
      entityType: 'supplier',
      entityId: row.id,
      actionText: `Created supplier "${row.companyName}" (ID ${row.id}).`,
      affectedItem: row.companyName,
    })
    return success(res, row, 201)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function update(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const row = await updateSupplier(
      tenantId,
      req.validated.params.id,
      {
        ...req.validated.body,
        ...filesFromRequest(req),
      },
      { branchId },
    )
    if (!row) return fail(res, 'Supplier not found', 404)
    await writeAdminActivity(tenantId, {
      branchId: row.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'orders_suppliers',
      action: 'supplier_update',
      entityType: 'supplier',
      entityId: row.id,
      actionText: `Edited supplier "${row.companyName}".`,
      affectedItem: row.companyName,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function setActive(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const isActive = req.validated.body.isActive
    const row = await setSupplierActive(
      tenantId,
      req.validated.params.id,
      isActive,
      { branchId },
    )
    if (!row) return fail(res, 'Supplier not found', 404)
    await writeAdminActivity(tenantId, {
      branchId: row.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'orders_suppliers',
      action: isActive ? 'supplier_unblock' : 'supplier_block',
      entityType: 'supplier',
      entityId: row.id,
      actionText: isActive
        ? `Unblocked supplier "${row.companyName}".`
        : `Blocked supplier "${row.companyName}". Supplier excluded from new order requests.`,
      affectedItem: row.companyName,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

// Hard delete (B2B only). Dependency check lives in the model. BM uses Block.
export async function remove(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const deleted = await deleteSupplier(tenantId, req.validated.params.id, { branchId })
    if (!deleted) return fail(res, 'Supplier not found', 404)
    await writeAdminActivity(tenantId, {
      branchId: deleted.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'orders_suppliers',
      action: 'supplier_delete',
      entityType: 'supplier',
      entityId: deleted.id,
      actionText: `Deleted supplier "${deleted.companyName}" (ID ${deleted.id}).`,
      affectedItem: deleted.companyName,
    })
    return success(res, { id: deleted.id, deleted: true })
  } catch (err) {
    return failFromError(res, err)
  }
}
