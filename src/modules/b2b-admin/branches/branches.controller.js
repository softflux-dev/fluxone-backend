import bcrypt from 'bcryptjs'
import {
  createBranchWithManager,
  deleteBranch,
  generateTemporaryPassword,
  getBranchById,
  getTenantName,
  listBranches,
  resetBranchManagerPassword,
  setBranchStatus,
  setManagerCredentialsEmailed,
  updateBranch,
} from './branches.model.js'
import { sendLoginCredentialsEmail } from '../../../mail/mail.service.js'
import { resolveUploadUrl } from '../../../utils/uploadUrl.util.js'
import { BCRYPT_COST } from '../../../config/constants.js'
import { fail, success, failFromError } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

function normalizeManager(body) {
  if (body.manager) return body.manager
  if (!body.managerName && !body.managerEmail) return null
  return {
    name: body.managerName,
    email: body.managerEmail,
    contact: body.managerContact,
    otherContact: body.managerOtherContact,
    gender: body.managerGender,
    address: body.managerAddress,
    profileImage: body.profileImage || body.managerProfileImage || body.managerImageUrl,
  }
}

function uploadedFile(req, fieldName) {
  return req.files?.[fieldName]?.[0] || (fieldName === 'image' ? req.file : null) || null
}

function loginAppUrl() {
  const base = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  return `${base.replace(/\/$/, '')}/login`
}

function maybeIncludeTempPassword(temporaryPassword, emailSent) {
  // Only expose temp password when email failed (admin recovery / Key flow).
  if (emailSent) return undefined
  if (process.env.NODE_ENV === 'production') return undefined
  return temporaryPassword
}

async function deliverCredentials({ branch, temporaryPassword, companyName, roleLabel }) {
  if (!branch?.manager?.email) {
    return { sent: false, stubbed: true }
  }
  return sendLoginCredentialsEmail({
    recipientName: branch.manager.name,
    loginEmail: branch.manager.email,
    temporaryPassword,
    branchName: branch.name,
    companyName,
    loginUrl: loginAppUrl(),
    roleLabel,
  })
}

async function syncCredentialsEmailedFlag(tenantId, branch, mail) {
  const managerId = branch?.manager?.id
  if (!managerId) return branch
  const emailed = Boolean(mail?.sent)
  await setManagerCredentialsEmailed(tenantId, managerId, emailed)
  return getBranchById(tenantId, branch.id)
}

export async function branchesList(req, res) {
  const result = await listBranches(req.tenantId, req.validated.query)
  return success(res, paginatedResult(result.items, result))
}

export async function branchDetail(req, res) {
  const row = await getBranchById(req.tenantId, req.validated.params.id)
  if (!row) return fail(res, 'Branch not found', 404)
  return success(res, row)
}

export async function createBranch(req, res) {
  const body = req.validated.body
  const manager = normalizeManager(body)
  if (!manager?.name?.trim() || !manager?.email?.trim()) {
    return fail(res, 'manager name and email are required', 400)
  }

  const temporaryPassword = generateTemporaryPassword()
  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST)

  let created
  try {
    const managerProfileImage = resolveUploadUrl(uploadedFile(req, 'profile_image'), req)
    created = await createBranchWithManager(req.tenantId, {
      name: body.name,
      location: body.location,
      image: resolveUploadUrl(uploadedFile(req, 'image'), req) || undefined,
      status: body.status,
      openingTime: body.openingTime,
      closingTime: body.closingTime,
      workingDays: body.workingDays,
      manager: {
        ...manager,
        ...(managerProfileImage ? { profileImage: managerProfileImage } : {}),
      },
      passwordHash,
    })
  } catch (err) {
    return failFromError(res, err)
  }

  const companyName = await getTenantName(req.tenantId)
  const mail = await deliverCredentials({
    branch: created,
    temporaryPassword,
    companyName,
    roleLabel: 'Branch Manager',
  })

  const branch = await syncCredentialsEmailedFlag(req.tenantId, created, mail)

  return success(
    res,
    {
      ...branch,
      credentials: {
        email: branch.manager?.email,
        emailed: mail.sent,
        stubbed: mail.stubbed,
        temporaryPassword: maybeIncludeTempPassword(temporaryPassword, mail.sent),
      },
    },
    201,
  )
}

export async function patchBranch(req, res) {
  const body = req.validated.body
  const manager = normalizeManager(body)

  let row
  try {
    const uploadedBranchImage = resolveUploadUrl(uploadedFile(req, 'image'), req)
    const uploadedManagerImage = resolveUploadUrl(uploadedFile(req, 'profile_image'), req)
    const managerPayload = manager
      ? {
          ...manager,
          ...(uploadedManagerImage ? { profileImage: uploadedManagerImage } : {}),
        }
      : uploadedManagerImage
        ? { profileImage: uploadedManagerImage }
        : undefined

    row = await updateBranch(req.tenantId, req.validated.params.id, {
      name: body.name,
      location: body.location,
      ...(uploadedBranchImage ? { image: uploadedBranchImage } : {}),
      ...(body.openingTime !== undefined ? { openingTime: body.openingTime || null } : {}),
      ...(body.closingTime !== undefined ? { closingTime: body.closingTime || null } : {}),
      ...(body.workingDays !== undefined ? { workingDays: body.workingDays } : {}),
      manager: managerPayload,
    })
  } catch (err) {
    return failFromError(res, err)
  }

  if (!row) return fail(res, 'Branch not found', 404)
  await writeAdminActivity(req.tenantId, {
    branchId: row.id,
    actorUserId: req.user?.id,
    actorRole: req.user?.role,
    category: 'settings',
    action: 'branch_settings_update',
    entityType: 'branch',
    entityId: row.id,
    actionText: `Updated branch setting(s) for "${row.name}".`,
    affectedItem: row.name,
  })
  return success(res, row)
}

export async function patchBranchStatus(req, res) {
  try {
    const row = await setBranchStatus(
      req.tenantId,
      req.validated.params.id,
      req.validated.body.status,
    )
    await writeAdminActivity(req.tenantId, {
      branchId: row.id,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'branch_status',
      entityType: 'branch',
      entityId: row.id,
      actionText: `Changed status of branch "${row.name}" to ${row.status}.`,
      affectedItem: row.name,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function resetPassword(req, res) {
  const override = req.validated.body?.password
  const temporaryPassword = override || generateTemporaryPassword()
  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST)

  let branch
  try {
    branch = await resetBranchManagerPassword(
      req.tenantId,
      req.validated.params.id,
      passwordHash,
    )
  } catch (err) {
    return failFromError(res, err)
  }

  const companyName = await getTenantName(req.tenantId)
  const mail = await deliverCredentials({
    branch,
    temporaryPassword,
    companyName,
    roleLabel: 'Branch Manager',
  })

  branch = await syncCredentialsEmailedFlag(req.tenantId, branch, mail)

  return success(res, {
    ...branch,
    credentials: {
      email: branch.manager?.email,
      emailed: mail.sent,
      stubbed: mail.stubbed,
      temporaryPassword: maybeIncludeTempPassword(temporaryPassword, mail.sent),
    },
  })
}

export async function removeBranch(req, res) {
  try {
    const result = await deleteBranch(req.tenantId, req.validated.params.id)
    return success(res, result)
  } catch (err) {
    return failFromError(res, err)
  }
}
