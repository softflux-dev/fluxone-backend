import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function calculateDays(startDate, endDate) {
  if (!startDate || !endDate) return 1
  const s = new Date(startDate)
  const e = new Date(endDate)
  const diffTime = Math.abs(e.getTime() - s.getTime())
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
  return Math.max(1, diffDays)
}

function formatDate(val) {
  if (!val) return null
  if (typeof val === 'string') return val.slice(0, 10)
  return new Date(val).toISOString().slice(0, 10)
}

export async function listHolidaySchedules(tenantId, { branchId = null } = {}) {
  // 1. Active staff count for this branch (All Employees display)
  const { rows: staffCountRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS "totalStaff"
      FROM staff s
      JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND s.status = 'active'
        AND u.is_active = true
        AND ($2::uuid IS NULL OR s.branch_id = $2)
    `,
    [branchId],
  )
  const totalActiveStaff = staffCountRows[0]?.totalStaff || 0

  // 2. Branch-owned schedules only — never leak null/other-branch rows to a BM
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        hs.id,
        hs.name,
        hs.start_date AS "startDate",
        hs.end_date AS "endDate",
        hs.is_all_employees AS "isAllEmployees",
        hs.status,
        hs.branch_id AS "branchId",
        hs.created_at AS "createdAt",
        COALESCE(
          array_agg(hss.staff_id) FILTER (WHERE hss.staff_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS "employeeIds"
      FROM holiday_schedules hs
      LEFT JOIN holiday_schedule_staff hss
        ON hss.holiday_schedule_id = hs.id AND hss.tenant_id = hs.tenant_id
      WHERE hs.tenant_id = $1
        AND (
          ($2::uuid IS NULL AND hs.branch_id IS NOT NULL)
          OR hs.branch_id = $2
        )
      GROUP BY hs.id
      ORDER BY hs.start_date DESC, hs.created_at DESC
    `,
    [branchId],
  )

  return rows.map((row) => {
    const sDate = formatDate(row.startDate)
    const eDate = formatDate(row.endDate)
    const noOfDays = calculateDays(sDate, eDate)
    const employeeIds = row.employeeIds || []
    const noOfEmployees = row.isAllEmployees ? totalActiveStaff : employeeIds.length

    return {
      id: row.id,
      name: row.name,
      startDate: sDate,
      endDate: eDate,
      holidayDate: sDate,
      noOfDays,
      isAllEmployees: row.isAllEmployees,
      noOfEmployees,
      totalActiveStaff,
      status: row.status || 'active',
      branchId: row.branchId,
      assignedEmployees: [],
      employeeIds,
      createdAt: row.createdAt,
    }
  })
}

export async function getHolidayScheduleById(tenantId, id, { branchId = null } = {}) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        hs.id,
        hs.name,
        hs.start_date AS "startDate",
        hs.end_date AS "endDate",
        hs.is_all_employees AS "isAllEmployees",
        hs.status,
        hs.branch_id AS "branchId",
        hs.created_at AS "createdAt",
        COALESCE(
          json_agg(
            json_build_object(
              'id', s.id,
              'fullName', u.full_name,
              'designation', COALESCE(d.name, s.designation, 'Staff')
            )
          ) FILTER (WHERE s.id IS NOT NULL),
          '[]'::json
        ) AS "assignedEmployees",
        COALESCE(
          array_agg(hss.staff_id) FILTER (WHERE hss.staff_id IS NOT NULL),
          ARRAY[]::uuid[]
        ) AS "employeeIds"
      FROM holiday_schedules hs
      LEFT JOIN holiday_schedule_staff hss
        ON hss.holiday_schedule_id = hs.id AND hss.tenant_id = hs.tenant_id
      LEFT JOIN staff s
        ON s.id = hss.staff_id AND s.tenant_id = hs.tenant_id
      LEFT JOIN users u
        ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN designations d
        ON d.id = s.designation_id AND d.tenant_id = s.tenant_id
      WHERE hs.tenant_id = $1
        AND hs.id = $2
        AND ($3::uuid IS NULL OR hs.branch_id = $3)
      GROUP BY hs.id
      LIMIT 1
    `,
    [id, branchId],
  )
  if (!rows[0]) return null
  const row = rows[0]
  const sDate = formatDate(row.startDate)
  const eDate = formatDate(row.endDate)

  return {
    id: row.id,
    name: row.name,
    startDate: sDate,
    endDate: eDate,
    holidayDate: sDate,
    noOfDays: calculateDays(sDate, eDate),
    isAllEmployees: row.isAllEmployees,
    status: row.status || 'active',
    branchId: row.branchId,
    assignedEmployees: row.assignedEmployees || [],
    employeeIds: row.employeeIds || [],
    createdAt: row.createdAt,
  }
}

export async function createHolidaySchedule(
  tenantId,
  { name, startDate, endDate, isAllEmployees = true, employeeIds = [], status = 'active', branchId = null },
) {
  // Holidays are branch-owned — never create unscoped (null branch_id) rows
  if (!branchId) throw httpError(400, 'branchId is required for holiday schedules')

  return withTransaction(async (client) => {
    const sDate = formatDate(startDate)
    const eDate = formatDate(endDate || startDate)

    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO holiday_schedules (tenant_id, branch_id, name, start_date, end_date, is_all_employees, status)
        VALUES ($1, $2, $3, $4::date, $5::date, $6, $7)
        RETURNING id, name, start_date AS "startDate", end_date AS "endDate",
                  is_all_employees AS "isAllEmployees", status, branch_id AS "branchId"
      `,
      [branchId, name.trim(), sDate, eDate, Boolean(isAllEmployees), status || 'active'],
    )
    const schedule = rows[0]

    if (!isAllEmployees && Array.isArray(employeeIds) && employeeIds.length > 0) {
      const uniqueIds = [...new Set(employeeIds)]
      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO holiday_schedule_staff (tenant_id, holiday_schedule_id, staff_id)
          SELECT $1, $2, x.staff_id
          FROM unnest($3::uuid[]) AS x(staff_id)
          ON CONFLICT (tenant_id, holiday_schedule_id, staff_id) DO NOTHING
        `,
        [schedule.id, uniqueIds],
      )
    }

    return schedule
  })
}

export async function updateHolidaySchedule(
  tenantId,
  id,
  { name, startDate, endDate, isAllEmployees, employeeIds, status, branchId = null },
) {
  return withTransaction(async (client) => {
    // Light read inside the same transaction (avoid second heavy join round-trip)
    const { rows: existingRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          id,
          name,
          start_date AS "startDate",
          end_date AS "endDate",
          is_all_employees AS "isAllEmployees",
          status,
          branch_id AS "branchId"
        FROM holiday_schedules
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
      `,
      [id],
    )
    const existing = existingRows[0]
    if (!existing) throw httpError(404, 'Holiday schedule not found')

    const nextName = name !== undefined ? name.trim() : existing.name
    const nextStart = startDate !== undefined ? formatDate(startDate) : formatDate(existing.startDate)
    const nextEnd = endDate !== undefined ? formatDate(endDate) : formatDate(existing.endDate)
    const nextAll = isAllEmployees !== undefined ? Boolean(isAllEmployees) : existing.isAllEmployees
    const nextStatus = status !== undefined ? status : existing.status

    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE holiday_schedules
        SET
          name = $2,
          start_date = $3::date,
          end_date = $4::date,
          is_all_employees = $5,
          status = $6,
          updated_at = now()
        WHERE tenant_id = $1 AND id = $7
      `,
      [nextName, nextStart, nextEnd, nextAll, nextStatus, id],
    )

    let nextEmployeeIds = []
    if (employeeIds !== undefined || isAllEmployees !== undefined) {
      await tenantClientQuery(
        client,
        tenantId,
        `DELETE FROM holiday_schedule_staff WHERE tenant_id = $1 AND holiday_schedule_id = $2`,
        [id],
      )

      if (!nextAll && Array.isArray(employeeIds) && employeeIds.length > 0) {
        const uniqueIds = [...new Set(employeeIds)]
        await tenantClientQuery(
          client,
          tenantId,
          `
            INSERT INTO holiday_schedule_staff (tenant_id, holiday_schedule_id, staff_id)
            SELECT $1, $2, x.staff_id
            FROM unnest($3::uuid[]) AS x(staff_id)
            ON CONFLICT (tenant_id, holiday_schedule_id, staff_id) DO NOTHING
          `,
          [id, uniqueIds],
        )
        nextEmployeeIds = uniqueIds
      }
    } else if (!nextAll) {
      const { rows: idRows } = await tenantClientQuery(
        client,
        tenantId,
        `
          SELECT staff_id AS id
          FROM holiday_schedule_staff
          WHERE tenant_id = $1 AND holiday_schedule_id = $2
        `,
        [id],
      )
      nextEmployeeIds = idRows.map((r) => r.id)
    }

    return {
      id,
      name: nextName,
      startDate: nextStart,
      endDate: nextEnd,
      holidayDate: nextStart,
      noOfDays: calculateDays(nextStart, nextEnd),
      isAllEmployees: nextAll,
      status: nextStatus || 'active',
      branchId: existing.branchId ?? branchId,
      assignedEmployees: [],
      employeeIds: nextAll ? [] : nextEmployeeIds,
    }
  })
}

export async function deleteHolidaySchedule(tenantId, id, { branchId = null } = {}) {
  const existing = await getHolidayScheduleById(tenantId, id, { branchId })
  if (!existing) return null

  const { rows } = await tenantQuery(
    tenantId,
    `
      DELETE FROM holiday_schedules
      WHERE tenant_id = $1
        AND id = $2
        AND ($3::uuid IS NULL OR branch_id = $3)
      RETURNING id, name, start_date AS "startDate", end_date AS "endDate"
    `,
    [id, branchId],
  )
  return rows[0] || null
}

// Fallback legacy functions
export async function createHoliday(tenantId, { name, date }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      INSERT INTO holidays (tenant_id, holiday_date, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (tenant_id, holiday_date) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, holiday_date AS "holidayDate", name
    `,
    [date, name.trim()],
  )
  return rows[0]
}

export async function listHolidays(tenantId) {
  return listHolidaySchedules(tenantId)
}

export async function getHolidayById(tenantId, id) {
  return getHolidayScheduleById(tenantId, id)
}

export async function updateHoliday(tenantId, id, payload) {
  return updateHolidaySchedule(tenantId, id, payload)
}

export async function deleteHoliday(tenantId, id) {
  return deleteHolidaySchedule(tenantId, id)
}
