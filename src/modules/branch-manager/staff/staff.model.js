import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import { ROLE_IDS, ROLES, STAFF_STATUS } from '../../../config/constants.js'
import {
  CREATABLE_STAFF_ROLES,
  CREATABLE_STAFF_ROLE_SQL,
  STAFF_ROLE_TO_DESIGNATION,
} from './staff.access.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'
import { displayRefSearchHex, normalizeSearchQuery } from '../../../utils/displayRef.util.js'
import { getBranchHours } from '../../b2b-admin/branches/branches.model.js'
import {
  formatAllocatedSlot,
  normalizeWorkingDays,
  validateWorkingDaysAgainstBranch,
} from './schedule.validation.js'
import {
  assertHardwareAllocationAvailable,
  releaseActiveAllocationsForStaff,
  upsertStaffHardwareAllocation,
} from './hardwareAllocation.model.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// One active Inventory Manager per branch (Wah ≠ Taxilla; each may have its own IM)
async function assertSingleInventoryManager(
  client,
  tenantId,
  { branchId, excludeStaffId = null },
) {
  if (!branchId) return
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT s.id
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      WHERE s.tenant_id = $1
        AND s.branch_id = $2
        AND r.slug = $3
        AND s.status NOT IN ('inactive', 'blocked', 'branch_blocked')
        AND u.is_active = true
        AND ($4::uuid IS NULL OR s.id <> $4)
      LIMIT 1
    `,
    [branchId, ROLES.INVENTORY_MANAGER, excludeStaffId],
  )

  if (rows[0]) {
    throw httpError(
      409,
      'This branch already has an Inventory Manager. Only one Inventory Manager is allowed per branch.',
    )
  }
}

const staffSelect = `
  s.id,
  s.image_url AS "imageUrl",
  COALESCE(s.joined_at, s.created_at) AS "joiningDate",
  s.created_at AS "createdAt",
  s.designation_id AS "designationId",
  COALESCE(d.name, s.designation) AS "designation",
  s.hardware_device_id AS "hardwareDeviceId",
  hw.code AS "hardwareCode",
  hw.name AS "hardwareName",
  hw.type AS "hardwareType",
  hw.image_url AS "hardwareImageUrl",
  s.status,
  s.schedule_start AS "scheduleStart",
  s.schedule_break_start AS "scheduleBreakStart",
  s.schedule_break_end AS "scheduleBreakEnd",
  s.schedule_end AS "scheduleEnd",
  COALESCE(s.working_days, ARRAY[]::text[]) AS "workingDays",
  ha.start_time AS "hardwareAllocationStart",
  ha.end_time AS "hardwareAllocationEnd",
  s.branch_id AS "branchId",
  s.user_id AS "userId",
  u.full_name AS "fullName",
  u.email,
  u.phone,
  u.is_active AS "isActive",
  r.slug AS role
`

// Active hardware allocation window (may be a cashier sub-slot).
const staffAllocationJoin = `
  LEFT JOIN LATERAL (
    SELECT start_time, end_time
    FROM hardware_allocations ha0
    WHERE ha0.tenant_id = s.tenant_id
      AND ha0.staff_id = s.id
      AND ha0.status = 'active'
    ORDER BY ha0.created_at DESC
    LIMIT 1
  ) ha ON true
`

function mapStaffRow(row) {
  if (!row) return null
  const workingDays = Array.isArray(row.workingDays) ? row.workingDays : []
  return {
    ...row,
    workingDays,
    imageUrl: normalizeImageUrl(row.imageUrl),
    hardwareImageUrl: normalizeImageUrl(row.hardwareImageUrl) || null,
    // Display slot from shift + working days (null when unassigned / no schedule)
    hardwareAllocatedSlot: row.hardwareDeviceId
      ? formatAllocatedSlot({
          workingDays,
          scheduleStart: row.hardwareAllocationStart || row.scheduleStart,
          scheduleEnd: row.hardwareAllocationEnd || row.scheduleEnd,
        })
      : null,
  }
}

async function assertStaffDaysWithinBranch(
  tenantId,
  branchId,
  workingDays,
  { requireDays = true } = {},
) {
  const hours = await getBranchHours(tenantId, branchId)
  if (hours === null) throw httpError(404, 'Branch not found')
  const days = normalizeWorkingDays(workingDays)
  if (!days.length) {
    if (!requireDays) return hours
    throw httpError(400, 'Select at least one working day')
  }
  const message = validateWorkingDaysAgainstBranch(days, hours)
  if (message) throw httpError(400, message)
  return hours
}

function mapPgUniqueViolation(err, message) {
  if (err?.code === '23505') {
    const constraint = String(err.constraint || '')
    if (constraint.includes('uq_one_active_im_per_branch')) {
      throw httpError(
        409,
        'This branch already has an Inventory Manager. Only one Inventory Manager is allowed per branch.',
      )
    }
    if (constraint.includes('uq_hw_alloc_exclusive_device')) {
      throw httpError(
        409,
        'This hardware slot is no longer available. Please select another available slot.',
      )
    }
    throw httpError(409, message)
  }
  throw err
}

// Shared list/export filters — STF refs are UI-only (match via compact UUID hex)
function staffListFilterParams(filters = {}) {
  const q = normalizeSearchQuery(filters.q) || null
  const qHex = q ? displayRefSearchHex(q, 'STF') : null
  const hardwareType = filters.hardwareType || filters.type || null
  return [
    q,
    qHex,
    filters.designationId || null,
    filters.status || null,
    filters.branchId || null,
    filters.role || null,
    hardwareType,
  ]
}

// Shared WHERE for paginated list + unpaginated export ($1 = tenantId via tenantQuery)
const staffListWhereSql = `
        AND r.slug IN (${CREATABLE_STAFF_ROLE_SQL})
        AND (
          $2::text IS NULL
          OR u.full_name ILIKE '%' || $2 || '%'
          OR u.email ILIKE '%' || $2 || '%'
          OR s.id::text ILIKE '%' || $2 || '%'
          OR (
            $3::text IS NOT NULL
            AND REPLACE(LOWER(s.id::text), '-', '') ILIKE '%' || $3 || '%'
          )
        )
        AND ($4::uuid IS NULL OR s.designation_id = $4)
        AND ($5::text IS NULL OR s.status = $5)
        AND ($6::uuid IS NULL OR s.branch_id = $6)
        AND ($7::text IS NULL OR r.slug = $7)
        AND ($8::text IS NULL OR hw.type = $8)
`

export async function listStaff(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(50, Math.max(1, Number(filters.limit) || 8))
  const offset = (page - 1) * limit
  const params = staffListFilterParams(filters)

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = s.hardware_device_id
      WHERE s.tenant_id = $1
      ${staffListWhereSql}
    `,
    params,
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${staffSelect}
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = s.hardware_device_id
      ${staffAllocationJoin}
      WHERE s.tenant_id = $1
      ${staffListWhereSql}
      ORDER BY COALESCE(s.joined_at, s.created_at) DESC, u.full_name
      LIMIT $9 OFFSET $10
    `,
    [...params, limit, offset],
  )

  return { items: rows.map(mapStaffRow), total: countRows[0]?.total || 0, page, limit }
}

// Full filtered roster for CSV export (same filters as list — no pagination)
const STAFF_EXPORT_MAX = 5000

export async function listStaffForExport(tenantId, filters = {}) {
  const params = staffListFilterParams(filters)

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${staffSelect}
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = s.hardware_device_id
      ${staffAllocationJoin}
      WHERE s.tenant_id = $1
      ${staffListWhereSql}
      ORDER BY COALESCE(s.joined_at, s.created_at) DESC, u.full_name
      LIMIT $9
    `,
    [...params, STAFF_EXPORT_MAX],
  )

  return rows.map(mapStaffRow)
}

export async function getStaffById(tenantId, id, { branchId } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${staffSelect}
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = s.hardware_device_id
      ${staffAllocationJoin}
      WHERE s.tenant_id = $1
        AND s.id = $2
        AND ($3::uuid IS NULL OR s.branch_id = $3)
        AND r.slug IN (${CREATABLE_STAFF_ROLE_SQL})
      LIMIT 1
    `,
    [id, branchId || null],
  )
  return mapStaffRow(rows[0] || null)
}

async function lookupDesignation(client, tenantId, { designationId, designationName }) {
  if (designationId) {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, name, is_active AS "isActive"
        FROM designations
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
      `,
      [designationId],
    )
    if (!rows[0]) throw httpError(404, 'Designation not found')
    if (!rows[0].isActive) throw httpError(409, 'Designation is inactive')
    return { designationId: rows[0].id, designationName: rows[0].name }
  }

  if (!designationName?.trim()) {
    return { designationId: null, designationName: null }
  }

  const name = designationName.trim()
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, name, is_active AS "isActive"
      FROM designations
      WHERE tenant_id = $1 AND name = $2
      LIMIT 1
    `,
    [name],
  )
  if (!rows[0]) {
    throw httpError(
      400,
      `Designation "${name}" is not configured. Ask your B2B Admin to create it.`,
    )
  }
  if (!rows[0].isActive) throw httpError(409, 'Designation is inactive')
  return { designationId: rows[0].id, designationName: rows[0].name }
}

// Ensure fixed staff-role designation exists for this tenant (create if missing).
async function ensureDesignationByName(client, tenantId, name) {
  try {
    return await lookupDesignation(client, tenantId, { designationName: name })
  } catch (err) {
    if (err?.status !== 400) throw err
  }

  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO designations (tenant_id, name, is_active)
      VALUES ($1, $2, TRUE)
      RETURNING id, name
    `,
    [name],
  )
  return { designationId: rows[0].id, designationName: rows[0].name }
}

async function resolveStaffDesignation(client, tenantId, payload) {
  if (payload.designationId) {
    return lookupDesignation(client, tenantId, { designationId: payload.designationId })
  }

  if (payload.designation?.trim()) {
    return lookupDesignation(client, tenantId, { designationName: payload.designation })
  }

  const roleSlug =
    payload.role || Object.keys(ROLE_IDS).find((key) => ROLE_IDS[key] === payload.roleId)
  const mappedName = STAFF_ROLE_TO_DESIGNATION[roleSlug]
  if (mappedName) {
    return ensureDesignationByName(client, tenantId, mappedName)
  }

  throw httpError(400, 'designationId, designation, or a valid staff role is required')
}

export async function createStaffUser(tenantId, payload) {
  if (!payload.branchId) {
    throw httpError(400, 'branchId is required')
  }

  const allowedRoles = CREATABLE_STAFF_ROLES
  const roleSlug =
    payload.role ||
    Object.entries(ROLE_IDS).find(([, id]) => id === payload.roleId)?.[0]
  if (!allowedRoles.includes(roleSlug)) {
    throw httpError(
      400,
      `Staff role must be one of: ${CREATABLE_STAFF_ROLES.join(', ')}`,
    )
  }

  try {
    return await withTransaction(async (client) => {
      if (roleSlug === ROLES.INVENTORY_MANAGER) {
        await assertSingleInventoryManager(client, tenantId, {
          branchId: payload.branchId,
        })
      }

      const workingDays = normalizeWorkingDays(payload.workingDays)
      await assertStaffDaysWithinBranch(tenantId, payload.branchId, workingDays)

      // Schedule + role policy before insert (IM exclusive / Cashier shared)
      await assertHardwareAllocationAvailable(client, tenantId, {
        branchId: payload.branchId,
        hardwareDeviceId: payload.hardwareDeviceId || null,
        role: roleSlug,
        workingDays,
        scheduleStart: payload.scheduleStart || null,
        scheduleEnd: payload.scheduleEnd || null,
        allocationStart: payload.hardwareAllocationStart || null,
        allocationEnd: payload.hardwareAllocationEnd || null,
      })

      const resolved = await resolveStaffDesignation(client, tenantId, {
        ...payload,
        role: roleSlug,
      })

      const { rows: userRows } = await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO users (
            tenant_id, branch_id, role_id, full_name, email, password_hash, phone, is_active
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `,
        [
          payload.branchId,
          payload.roleId,
          payload.fullName,
          payload.email,
          payload.passwordHash,
          payload.phone || null,
          payload.status !== 'inactive' && payload.status !== 'blocked',
        ],
      )

      const userId = userRows[0].id

      const { rows: staffRows } = await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO staff (
            tenant_id, user_id, branch_id, designation, designation_id,
            hardware_device_id, image_url, status,
            schedule_start, schedule_break_start, schedule_break_end, schedule_end,
            working_days, joined_at, created_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            COALESCE($14::timestamptz, now()), $15
          )
          RETURNING id
        `,
        [
          userId,
          payload.branchId,
          resolved.designationName,
          resolved.designationId,
          payload.hardwareDeviceId || null,
          payload.imageUrl || null,
          payload.status || 'active',
          payload.scheduleStart || null,
          payload.scheduleBreakStart || null,
          payload.scheduleBreakEnd || null,
          payload.scheduleEnd || null,
          workingDays,
          payload.joinedAt || null,
          payload.createdBy || null,
        ],
      )

      const staffId = staffRows[0].id

      // Persist allocation row (source of truth for conflicts / IM lock)
      await upsertStaffHardwareAllocation(client, tenantId, {
        branchId: payload.branchId,
        staffId,
        role: roleSlug,
        hardwareDeviceId: payload.hardwareDeviceId || null,
        workingDays,
        scheduleStart: payload.scheduleStart || null,
        scheduleEnd: payload.scheduleEnd || null,
        allocationStart: payload.hardwareAllocationStart || null,
        allocationEnd: payload.hardwareAllocationEnd || null,
      })

      return getStaffByIdInTx(client, tenantId, staffId)
    })
  } catch (err) {
    mapPgUniqueViolation(err, 'A user with this Login ID/Email already exists')
  }
}

async function getStaffByIdInTx(client, tenantId, id, { branchId } = {}) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT ${staffSelect}
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      LEFT JOIN branch_hardware hw
        ON hw.tenant_id = s.tenant_id
       AND hw.id::text = s.hardware_device_id
      ${staffAllocationJoin}
      WHERE s.tenant_id = $1
        AND s.id = $2
        AND ($3::uuid IS NULL OR s.branch_id = $3)
        AND r.slug IN (${CREATABLE_STAFF_ROLE_SQL})
      LIMIT 1
    `,
    [id, branchId || null],
  )
  return mapStaffRow(rows[0] || null)
}

export async function updateStaff(tenantId, id, payload, { branchId } = {}) {
  try {
    return await withTransaction(async (client) => {
      const existing = await getStaffByIdInTx(client, tenantId, id, { branchId })
      if (!existing) throw httpError(404, 'Staff not found')

      const nextRole = payload.role || existing.role
      const nextBranchId =
        payload.branchId !== undefined ? payload.branchId : existing.branchId

      if (nextRole === ROLES.INVENTORY_MANAGER) {
        await assertSingleInventoryManager(client, tenantId, {
          branchId: nextBranchId,
          excludeStaffId: existing.id,
        })
      }

      const nextWorkingDays =
        payload.workingDays !== undefined
          ? normalizeWorkingDays(payload.workingDays)
          : normalizeWorkingDays(existing.workingDays)
      const nextScheduleStart =
        payload.scheduleStart !== undefined
          ? payload.scheduleStart
          : existing.scheduleStart
      const nextScheduleEnd =
        payload.scheduleEnd !== undefined ? payload.scheduleEnd : existing.scheduleEnd
      const nextHardwareId =
        payload.hardwareDeviceId !== undefined
          ? payload.hardwareDeviceId || null
          : existing.hardwareDeviceId || null

      // Status → inactive/blocked: release hardware claim (history kept as released)
      const nextStatus = payload.status !== undefined ? payload.status : existing.status
      const becomingInactive =
        payload.status !== undefined &&
        (payload.status === STAFF_STATUS.INACTIVE || payload.status === 'blocked') &&
        existing.status !== STAFF_STATUS.INACTIVE &&
        existing.status !== 'blocked'

      if (becomingInactive) {
        await releaseActiveAllocationsForStaff(client, tenantId, existing.id)
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE users
            SET
              full_name = COALESCE($2, full_name),
              email = COALESCE($3, email),
              phone = COALESCE($4, phone),
              branch_id = COALESCE($5, branch_id),
              role_id = COALESCE($6, role_id),
              password_hash = COALESCE($7, password_hash),
              is_active = false
            WHERE tenant_id = $1 AND id = $8
          `,
          [
            payload.fullName || null,
            payload.email || null,
            payload.phone !== undefined ? payload.phone : null,
            nextBranchId,
            payload.role ? ROLE_IDS[payload.role] : null,
            payload.passwordHash || null,
            existing.userId,
          ],
        )
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE staff
            SET
              status = $2,
              hardware_device_id = NULL,
              branch_id = COALESCE($3, branch_id)
            WHERE tenant_id = $1 AND id = $4
          `,
          [nextStatus, nextBranchId, id],
        )
        return getStaffByIdInTx(client, tenantId, id, { branchId })
      }

      await assertStaffDaysWithinBranch(tenantId, nextBranchId, nextWorkingDays, {
        // Legacy rows may have empty days until edited; require when assigning hardware or patching days
        requireDays:
          Boolean(nextHardwareId) || payload.workingDays !== undefined,
      })

      // Re-validate merged schedule + allocation (reject invalid keep on schedule edit)
      const nextAllocationStart =
        payload.hardwareAllocationStart !== undefined
          ? payload.hardwareAllocationStart
          : existing.hardwareAllocationStart
      const nextAllocationEnd =
        payload.hardwareAllocationEnd !== undefined
          ? payload.hardwareAllocationEnd
          : existing.hardwareAllocationEnd

      await assertHardwareAllocationAvailable(client, tenantId, {
        branchId: nextBranchId,
        hardwareDeviceId: nextHardwareId,
        role: nextRole,
        workingDays: nextWorkingDays,
        scheduleStart: nextScheduleStart,
        scheduleEnd: nextScheduleEnd,
        allocationStart: nextAllocationStart,
        allocationEnd: nextAllocationEnd,
        excludeStaffId: existing.id,
      })

      let designationName = existing.designation
      let designationId = existing.designationId
      if (
        payload.designationId !== undefined ||
        payload.designation !== undefined ||
        payload.role !== undefined
      ) {
        const resolved = await resolveStaffDesignation(client, tenantId, {
          designationId: payload.designationId,
          designation: payload.designation,
          role: nextRole,
        })
        designationName = resolved.designationName
        designationId = resolved.designationId
      }

      const roleId = payload.role ? ROLE_IDS[payload.role] : null

      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE users
          SET
            full_name = COALESCE($2, full_name),
            email = COALESCE($3, email),
            phone = COALESCE($4, phone),
            branch_id = COALESCE($5, branch_id),
            role_id = COALESCE($6, role_id),
            password_hash = COALESCE($7, password_hash),
            is_active = CASE
              WHEN $8::text IS NULL THEN is_active
              ELSE ($8::text NOT IN ('inactive', 'blocked'))
            END
          WHERE tenant_id = $1 AND id = $9
        `,
        [
          payload.fullName || null,
          payload.email || null,
          payload.phone !== undefined ? payload.phone : null,
          nextBranchId,
          roleId,
          payload.passwordHash || null,
          payload.status || null,
          existing.userId,
        ],
      )

      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE staff
          SET
            designation = COALESCE($2, designation),
            designation_id = COALESCE($3, designation_id),
            hardware_device_id = $4,
            image_url = COALESCE($5, image_url),
            status = COALESCE($6, status),
            schedule_start = CASE WHEN $7::boolean THEN $8::time ELSE schedule_start END,
            schedule_break_start = CASE WHEN $9::boolean THEN $10::time ELSE schedule_break_start END,
            schedule_break_end = CASE WHEN $11::boolean THEN $12::time ELSE schedule_break_end END,
            schedule_end = CASE WHEN $13::boolean THEN $14::time ELSE schedule_end END,
            working_days = CASE WHEN $15::boolean THEN $16::text[] ELSE working_days END,
            branch_id = COALESCE($17, branch_id)
          WHERE tenant_id = $1 AND id = $18
        `,
        [
          designationName,
          payload.designationId !== undefined ||
            payload.designation !== undefined ||
            payload.role !== undefined
            ? designationId
            : null,
          nextHardwareId,
          payload.imageUrl || null,
          payload.status || null,
          payload.scheduleStart !== undefined,
          payload.scheduleStart !== undefined ? payload.scheduleStart : null,
          payload.scheduleBreakStart !== undefined,
          payload.scheduleBreakStart !== undefined ? payload.scheduleBreakStart : null,
          payload.scheduleBreakEnd !== undefined,
          payload.scheduleBreakEnd !== undefined ? payload.scheduleBreakEnd : null,
          payload.scheduleEnd !== undefined,
          payload.scheduleEnd !== undefined ? payload.scheduleEnd : null,
          payload.workingDays !== undefined,
          payload.workingDays !== undefined ? nextWorkingDays : null,
          nextBranchId,
          id,
        ],
      )

      // Keep allocation row in sync with staff schedule / device
      const shouldRefreshAllocation =
        payload.hardwareDeviceId !== undefined ||
        payload.workingDays !== undefined ||
        payload.scheduleStart !== undefined ||
        payload.scheduleEnd !== undefined ||
        payload.hardwareAllocationStart !== undefined ||
        payload.hardwareAllocationEnd !== undefined ||
        payload.role !== undefined ||
        payload.branchId !== undefined

      if (shouldRefreshAllocation) {
        await upsertStaffHardwareAllocation(client, tenantId, {
          branchId: nextBranchId,
          staffId: existing.id,
          role: nextRole,
          hardwareDeviceId: nextHardwareId,
          workingDays: nextWorkingDays,
          scheduleStart: nextScheduleStart,
          scheduleEnd: nextScheduleEnd,
          allocationStart: nextAllocationStart,
          allocationEnd: nextAllocationEnd,
        })
      }

      return getStaffByIdInTx(client, tenantId, id, { branchId })
    })
  } catch (err) {
    mapPgUniqueViolation(err, 'A user with this Login ID/Email already exists')
  }
}

export async function setStaffStatus(tenantId, id, status, { branchId } = {}) {
  return withTransaction(async (client) => {
    const existing = await getStaffByIdInTx(client, tenantId, id, { branchId })
    if (!existing) throw httpError(404, 'Staff not found')

    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE staff
        SET status = $2
        WHERE tenant_id = $1 AND id = $3
      `,
      [status, id],
    )

    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE users
        SET is_active = ($2::text NOT IN ('inactive', 'blocked'))
        WHERE tenant_id = $1 AND id = $3
      `,
      [status, existing.userId],
    )

    // Deactivate → release future hardware claim (history rows stay as released)
    if (status === STAFF_STATUS.INACTIVE || status === 'blocked') {
      await releaseActiveAllocationsForStaff(client, tenantId, id)
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE staff
          SET hardware_device_id = NULL
          WHERE tenant_id = $1 AND id = $2
        `,
        [id],
      )
    }

    return getStaffByIdInTx(client, tenantId, id, { branchId })
  })
}

// Hard-delete staff user (staff row cascades from user). Branch-scoped for BM.
export async function deleteStaff(tenantId, id, { branchId } = {}) {
  return withTransaction(async (client) => {
    const existing = await getStaffByIdInTx(client, tenantId, id, { branchId })
    if (!existing) throw httpError(404, 'Staff not found')

    await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM users
        WHERE tenant_id = $1 AND id = $2
      `,
      [existing.userId],
    )

    return existing
  })
}
