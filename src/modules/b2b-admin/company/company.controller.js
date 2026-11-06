import { getCompany, updateCompany } from './company.model.js'
import { resolveUploadUrl } from '../../../utils/uploadUrl.util.js'
import { fail, success, failFromError } from '../../../utils/response.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

export async function companyDetail(req, res) {
  const row = await getCompany(req.tenantId)
  if (!row) return fail(res, 'Company not found', 404)
  return success(res, row)
}

export async function patchCompany(req, res) {
  const body = req.validated.body
  const uploadedLogo = resolveUploadUrl(req.file || req.files?.logo?.[0], req)

  try {
    const row = await updateCompany(req.tenantId, {
      name: body.name,
      contactNumbers: body.contactNumbers,
      whatsappNumber: body.whatsappNumber,
      facebookUrl: body.facebookUrl,
      instagramUrl: body.instagramUrl,
      registrationTaxId: body.registrationTaxId,
      businessAddress: body.businessAddress,
      supportEmail: body.supportEmail,
      ...(uploadedLogo
        ? { logoUrl: uploadedLogo }
        : body.logoUrl !== undefined
          ? { logoUrl: body.logoUrl }
          : {}),
    })
    if (!row) return fail(res, 'Company not found', 404)
    // Admin Logs — Settings / Other (§5.7 company profile)
    await writeAdminActivity(req.tenantId, {
      branchId: req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'company_settings',
      entityType: 'tenant',
      entityId: req.tenantId,
      actionText: `Updated company profile "${row.name || 'Company'}".`,
      affectedItem: row.name || 'Company',
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}
