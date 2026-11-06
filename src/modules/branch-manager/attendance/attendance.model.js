import { tenantQuery } from '../../../config/db.js'

export async function upsertAttendance(tenantId, payload) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO attendance (tenant_id, staff_id, work_date, status, note, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, staff_id, work_date)
      DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note
      RETURNING id, to_char(work_date, 'YYYY-MM-DD') AS "workDate", status
    `,
    [payload.staffId, payload.workDate, payload.status, payload.note || null, payload.createdBy],
  )
  return rows[0]
}

export async function listAttendance(tenantId, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT a.id, to_char(a.work_date, 'YYYY-MM-DD') AS "workDate", a.status, a.note, s.id AS "staffId"
      FROM attendance a
      JOIN staff s ON s.id = a.staff_id AND s.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND ($2::uuid IS NULL OR s.branch_id = $2)
      ORDER BY a.work_date DESC
    `,
    [branchId],
  )
  return rows
}

/** Clear holiday/leave attendance marks for a staff over dates (only matching status). */
export async function clearAttendanceMarks(tenantId, { staffId, dates, status, note = null }) {
  if (!staffId || !Array.isArray(dates) || dates.length === 0 || !status) return { rowCount: 0 }

  const { rowCount } = await tenantQuery(
    tenantId,
    `
      DELETE FROM attendance
      WHERE tenant_id = $1
        AND staff_id = $2
        AND status = $3
        AND work_date = ANY($4::date[])
        AND ($5::text IS NULL OR note = $5)
    `,
    [staffId, status, dates, note],
  )
  return { rowCount: rowCount || 0 }
}

/** Clear all holiday marks for a given date + holiday name (any staff). */
export async function clearHolidayAttendanceByDate(tenantId, { workDate, note }) {
  const { rowCount } = await tenantQuery(
    tenantId,
    `
      DELETE FROM attendance
      WHERE tenant_id = $1
        AND work_date = $2::date
        AND status = 'holiday'
        AND ($3::text IS NULL OR note = $3)
    `,
    [workDate, note || null],
  )
  return { rowCount: rowCount || 0 }
}

//
// Batch clear — holiday marks for dates (+ optional branch / staff scope).
// Always pass branchId or staffIds from holiday sync so other branches stay untouched.
//
export async function clearHolidayAttendanceByDates(
  tenantId,
  { dates, note, branchId = null, staffIds = null },
) {
  const list = Array.isArray(dates) ? dates.filter(Boolean) : []
  if (!list.length) return { rowCount: 0 }

  const scopedStaff = Array.isArray(staffIds)
    ? [...new Set(staffIds.filter(Boolean))]
    : null

  // Prefer explicit staff list (already branch-resolved by holiday sync)
  if (scopedStaff?.length) {
    const { rowCount } = await tenantQuery(
      tenantId,
      `
        DELETE FROM attendance
        WHERE tenant_id = $1
          AND status = 'holiday'
          AND work_date = ANY($2::date[])
          AND ($3::text IS NULL OR note = $3)
          AND staff_id = ANY($4::uuid[])
      `,
      [list, note || null, scopedStaff],
    )
    return { rowCount: rowCount || 0 }
  }

  // Branch-scoped clear — join staff so other branches are never wiped
  if (branchId) {
    const { rowCount } = await tenantQuery(
      tenantId,
      `
        DELETE FROM attendance a
        USING staff s
        WHERE a.tenant_id = $1
          AND s.tenant_id = a.tenant_id
          AND s.id = a.staff_id
          AND s.branch_id = $4
          AND a.status = 'holiday'
          AND a.work_date = ANY($2::date[])
          AND ($3::text IS NULL OR a.note = $3)
      `,
      [list, note || null, branchId],
    )
    return { rowCount: rowCount || 0 }
  }

  // No scope — refuse broad wipe (legacy callers must pass branchId / staffIds)
  return { rowCount: 0 }
}

//
// Batch upsert holiday marks — staff_ids × dates in one INSERT (CROSS JOIN unnest).
//
export async function batchUpsertHolidayAttendance(
  tenantId,
  { staffIds, dates, note, createdBy },
) {
  const staffList = Array.isArray(staffIds) ? [...new Set(staffIds.filter(Boolean))] : []
  const dateList = Array.isArray(dates) ? dates.filter(Boolean) : []
  if (!staffList.length || !dateList.length) return { rowCount: 0 }

  const { rowCount } = await tenantQuery(
    tenantId,
    `
      INSERT INTO attendance (tenant_id, staff_id, work_date, status, note, created_by)
      SELECT
        $1,
        s.staff_id,
        d.work_date,
        'holiday',
        $2,
        $3
      FROM unnest($4::uuid[]) AS s(staff_id)
      CROSS JOIN unnest($5::date[]) AS d(work_date)
      ON CONFLICT (tenant_id, staff_id, work_date)
      DO UPDATE SET
        status = EXCLUDED.status,
        note = EXCLUDED.note,
        created_by = COALESCE(EXCLUDED.created_by, attendance.created_by)
    `,
    [note || null, createdBy || null, staffList, dateList],
  )
  return { rowCount: rowCount || 0 }
}
