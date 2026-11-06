import { tenantQuery } from '../../../config/db.js'

const LEAVE_SELECT = `
  l.id,
  l.leave_for AS "leaveFor",
  l.branch_id AS "branchId",
  l.staff_id AS "staffId",
  l.requested_by AS "requestedBy",
  l.start_date AS "startDate",
  l.end_date AS "endDate",
  l.reason,
  l.status,
  l.created_at AS "createdAt",
  l.decided_by AS "decidedBy",
  l.decided_at AS "decidedAt",
  l.decision_reason AS "decisionReason"
`

// Staff leave: BM appoints for an employee (auto-approved)
export async function createStaffLeave(
  tenantId,
  { staffId, branchId, requestedBy, startDate, endDate, reason, status = 'approved' },
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO leaves (
        tenant_id, leave_for, staff_id, branch_id, requested_by,
        start_date, end_date, reason, status
      )
      VALUES ($1, 'staff', $2, $3, $4, $5, $6, $7, $8)
      RETURNING
        id,
        leave_for AS "leaveFor",
        branch_id AS "branchId",
        staff_id AS "staffId",
        requested_by AS "requestedBy",
        start_date AS "startDate",
        end_date AS "endDate",
        reason,
        status,
        created_at AS "createdAt",
        decided_by AS "decidedBy",
        decided_at AS "decidedAt"
    `,
    [staffId, branchId, requestedBy || null, startDate, endDate, reason || null, status],
  )
  return rows[0]
}

// BM self leave: pending until Admin approves/rejects
export async function createMyLeave(
  tenantId,
  { branchId, requestedBy, startDate, endDate, reason },
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO leaves (
        tenant_id, leave_for, staff_id, branch_id, requested_by,
        start_date, end_date, reason, status
      )
      VALUES ($1, 'branch_manager', NULL, $2, $3, $4, $5, $6, 'pending')
      RETURNING
        id,
        leave_for AS "leaveFor",
        branch_id AS "branchId",
        staff_id AS "staffId",
        requested_by AS "requestedBy",
        start_date AS "startDate",
        end_date AS "endDate",
        reason,
        status,
        created_at AS "createdAt",
        decided_by AS "decidedBy",
        decided_at AS "decidedAt",
        decision_reason AS "decisionReason"
    `,
    [branchId, requestedBy, startDate, endDate, reason || null],
  )
  return rows[0]
}

// Staff roster leaves for a branch (excludes BM self-requests)
export async function listStaffLeaves(tenantId, { branchId, designationId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        ${LEAVE_SELECT},
        u.full_name AS "fullName",
        s.designation_id AS "designationId",
        d.name AS "designation"
      FROM leaves l
      JOIN staff s ON s.id = l.staff_id AND s.tenant_id = l.tenant_id
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      WHERE l.tenant_id = $1
        AND l.leave_for = 'staff'
        AND ($2::uuid IS NULL OR l.branch_id = $2)
        AND ($3::uuid IS NULL OR s.designation_id = $3)
      ORDER BY l.created_at DESC
    `,
    [branchId || null, designationId || null],
  )
  return rows
}

// Leaves the signed-in BM requested for themselves
export async function listMyLeaves(tenantId, { requestedBy, branchId } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        ${LEAVE_SELECT}
      FROM leaves l
      WHERE l.tenant_id = $1
        AND l.leave_for = 'branch_manager'
        AND l.requested_by = $2
        AND ($3::uuid IS NULL OR l.branch_id = $3)
      ORDER BY l.created_at DESC
    `,
    [requestedBy, branchId || null],
  )
  return rows
}

export async function getLeaveById(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        ${LEAVE_SELECT},
        su.full_name AS "staffFullName",
        s.designation_id AS "designationId",
        d.name AS "designation",
        ru.full_name AS "requesterName",
        b.name AS "branchName"
      FROM leaves l
      LEFT JOIN staff s ON s.id = l.staff_id AND s.tenant_id = l.tenant_id
      LEFT JOIN users su ON su.id = s.user_id AND su.tenant_id = s.tenant_id
      LEFT JOIN designations d ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      LEFT JOIN users ru ON ru.id = l.requested_by AND ru.tenant_id = l.tenant_id
      LEFT JOIN branches b ON b.id = l.branch_id AND b.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1 AND l.id = $2
      LIMIT 1
    `,
    [id],
  )
  return rows[0] || null
}

// Same-date policy: block when pending/approved leave already overlaps the range.
// Rejected / cancelled leaves do not block a new request.
export async function findOverlappingLeave(
  tenantId,
  {
    leaveFor,
    requestedBy = null,
    staffId = null,
    startDate,
    endDate,
    excludeId = null,
  },
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        start_date AS "startDate",
        end_date AS "endDate",
        status
      FROM leaves
      WHERE tenant_id = $1
        AND leave_for = $2
        AND status IN ('pending', 'approved')
        AND start_date <= $3::date
        AND end_date >= $4::date
        AND (
          ($2 = 'branch_manager' AND requested_by = $5)
          OR ($2 = 'staff' AND staff_id = $6)
        )
        AND ($7::uuid IS NULL OR id <> $7)
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [leaveFor, endDate, startDate, requestedBy, staffId, excludeId],
  )
  return rows[0] || null
}

export async function updateLeave(tenantId, id, { startDate, endDate, reason, status }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE leaves
      SET
        start_date = COALESCE($2::date, start_date),
        end_date = COALESCE($3::date, end_date),
        reason = COALESCE($4, reason),
        status = COALESCE($5, status)
      WHERE tenant_id = $1 AND id = $6
      RETURNING
        id,
        leave_for AS "leaveFor",
        branch_id AS "branchId",
        staff_id AS "staffId",
        requested_by AS "requestedBy",
        start_date AS "startDate",
        end_date AS "endDate",
        reason,
        status,
        created_at AS "createdAt",
        decided_by AS "decidedBy",
        decided_at AS "decidedAt"
    `,
    [startDate || null, endDate || null, reason ?? null, status || null, id],
  )
  return rows[0] || null
}

// Admin approve / reject BM self-leave
export async function decideLeave(tenantId, id, { status, decidedBy, decisionReason = null }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      UPDATE leaves
      SET
        status = $2,
        decided_by = $3,
        decided_at = now(),
        decision_reason = $4
      WHERE tenant_id = $1
        AND id = $5
        AND leave_for = 'branch_manager'
        AND status = 'pending'
      RETURNING
        id,
        leave_for AS "leaveFor",
        branch_id AS "branchId",
        staff_id AS "staffId",
        requested_by AS "requestedBy",
        start_date AS "startDate",
        end_date AS "endDate",
        reason,
        status,
        created_at AS "createdAt",
        decided_by AS "decidedBy",
        decided_at AS "decidedAt",
        decision_reason AS "decisionReason"
    `,
    [status, decidedBy, decisionReason, id],
  )
  return rows[0] || null
}

export async function deleteLeave(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      DELETE FROM leaves
      WHERE tenant_id = $1 AND id = $2
      RETURNING
        id,
        leave_for AS "leaveFor",
        branch_id AS "branchId",
        staff_id AS "staffId",
        start_date AS "startDate",
        end_date AS "endDate",
        reason,
        status
    `,
    [id],
  )
  return rows[0] || null
}

// Admin inbox: BM self-requests across the tenant
export async function listManagerLeaveRequests(
  tenantId,
  { branchId = null, status = null } = {},
) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        ${LEAVE_SELECT},
        ru.full_name AS "managerName",
        ru.email AS "managerEmail",
        ru.image_url AS "managerImageUrl",
        b.name AS "branchName",
        b.location AS "branchLocation",
        (l.end_date - l.start_date + 1) AS "dayCount"
      FROM leaves l
      JOIN users ru ON ru.id = l.requested_by AND ru.tenant_id = l.tenant_id
      LEFT JOIN branches b ON b.id = l.branch_id AND b.tenant_id = l.tenant_id
      WHERE l.tenant_id = $1
        AND l.leave_for = 'branch_manager'
        AND ($2::uuid IS NULL OR l.branch_id = $2)
        AND ($3::text IS NULL OR l.status = $3)
      ORDER BY
        CASE WHEN l.status = 'pending' THEN 0 ELSE 1 END,
        l.created_at DESC
    `,
    [branchId || null, status || null],
  )
  return rows
}
