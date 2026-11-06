import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import { ROLES } from '../../../config/constants.js'
import { ratingLabelFromScore, slugifyCriterion } from './performance.ratings.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function pctOfMax(points, maxScore) {
  const max = Number(maxScore)
  if (!Number.isFinite(max) || max <= 0) return 0
  return round2((Number(points || 0) / max) * 100)
}

function trendFromDelta(delta) {
  if (delta == null || !Number.isFinite(Number(delta))) {
    return { trendDelta: null, trendDirection: 'none' }
  }
  const value = round2(delta)
  if (value > 0) return { trendDelta: value, trendDirection: 'up' }
  if (value < 0) return { trendDelta: value, trendDirection: 'down' }
  return { trendDelta: 0, trendDirection: 'flat' }
}

function rangeStartIso(range) {
  const key = String(range || '12M').toUpperCase()
  if (key === 'ALL') return null
  const months = key === '3M' ? 3 : key === '6M' ? 6 : 12
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.toISOString()
}

// Latest scale version for tenant (active scoring definition)
export async function getActiveScale(tenantId) {
  const { rows: versions } = await tenantQuery(
    tenantId,
    `
      SELECT
        id,
        version_number AS "versionNumber",
        effective_from AS "effectiveFrom",
        change_summary AS "changeSummary"
      FROM scoring_scale_versions
      WHERE tenant_id = $1
      ORDER BY version_number DESC
      LIMIT 1
    `,
  )
  if (!versions.length) {
    return { version: null, criteria: [], pointsTotal: 0 }
  }
  const version = versions[0]
  const { rows: criteria } = await tenantQuery(
    tenantId,
    `
      SELECT
        vi.criterion_id AS id,
        vi.criterion_name AS name,
        vi.max_score AS "maxPoints",
        sc.code
      FROM scoring_scale_version_items vi
      INNER JOIN scoring_criteria sc
        ON sc.id = vi.criterion_id AND sc.tenant_id = $1
      WHERE vi.version_id = $2
      ORDER BY vi.criterion_name ASC
    `,
    [version.id],
  )
  const pointsTotal = criteria.reduce((sum, row) => sum + Number(row.maxPoints || 0), 0)
  return { version, criteria, pointsTotal }
}

function buildChangeSummary(prevItems, nextItems) {
  const prevMap = new Map(prevItems.map((i) => [i.criterionId, i]))
  const nextMap = new Map(nextItems.map((i) => [i.criterionId, i]))
  const parts = []

  for (const [id, next] of nextMap) {
    const prev = prevMap.get(id)
    if (!prev) {
      parts.push(`Added ${next.name}`)
      continue
    }
    if (prev.name !== next.name) parts.push(`Renamed "${prev.name}" → "${next.name}"`)
    if (Number(prev.maxPoints) !== Number(next.maxPoints)) {
      parts.push(`${next.name} ${prev.maxPoints} → ${next.maxPoints}`)
    }
  }
  for (const [id, prev] of prevMap) {
    if (!nextMap.has(id)) parts.push(`Removed ${prev.name}`)
  }
  return parts.length ? parts.join('; ') : 'Scale updated'
}

function scalesEqual(prevItems, nextItems) {
  if (prevItems.length !== nextItems.length) return false
  const prevMap = new Map(prevItems.map((i) => [i.criterionId, i]))
  for (const next of nextItems) {
    const prev = prevMap.get(next.criterionId)
    if (!prev) return false
    if (prev.name !== next.name) return false
    if (Number(prev.maxPoints) !== Number(next.maxPoints)) return false
  }
  return true
}

// Save full criteria set — creates a new version when anything changed (sum must be 100)
export async function saveScaleVersion(tenantId, { criteria, createdBy }) {
  const list = Array.isArray(criteria) ? criteria : []
  if (!list.length) throw httpError(422, 'At least one criterion is required')

  const pointsTotal = list.reduce((sum, row) => sum + Number(row.maxPoints || 0), 0)
  if (pointsTotal !== 100) {
    throw httpError(422, `Criteria maximums must add up to exactly 100 (currently ${pointsTotal})`)
  }

  return withTransaction(async (client) => {
    const active = await getActiveScale(tenantId)
    const prevItems = (active.criteria || []).map((c) => ({
      criterionId: c.id,
      name: c.name,
      maxPoints: Number(c.maxPoints),
    }))

    // Upsert criteria by id or code; keep stable IDs across renames
    const nextItems = []
    for (const row of list) {
      const name = String(row.name || '').trim()
      const maxPoints = Number(row.maxPoints)
      if (!name) throw httpError(422, 'Criterion name is required')
      if (!Number.isInteger(maxPoints) || maxPoints < 1) {
        throw httpError(422, 'Each criterion max must be a whole number ≥ 1')
      }

      let criterionId = row.id || null
      const code = slugifyCriterion(name) || `criterion_${Date.now()}`

      if (criterionId) {
        const { rows } = await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE scoring_criteria
            SET name = $2
            WHERE tenant_id = $1 AND id = $3
            RETURNING id, name, code
          `,
          [name, criterionId],
        )
        if (!rows.length) throw httpError(404, 'Criterion not found')
        criterionId = rows[0].id
      } else {
        const { rows } = await tenantClientQuery(
          client,
          tenantId,
          `
            INSERT INTO scoring_criteria (tenant_id, code, name)
            VALUES ($1, $2, $3)
            ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
            RETURNING id, name, code
          `,
          [code, name],
        )
        criterionId = rows[0].id
      }

      nextItems.push({ criterionId, name, maxPoints })
    }

    if (active.version && scalesEqual(prevItems, nextItems)) {
      return getActiveScale(tenantId)
    }

    const nextVersionNumber = active.version ? Number(active.version.versionNumber) + 1 : 1
    const changeSummary = active.version
      ? buildChangeSummary(prevItems, nextItems)
      : 'Initial scoring scale'

    const { rows: versionRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO scoring_scale_versions (
          tenant_id, version_number, effective_from, change_summary, created_by
        )
        VALUES ($1, $2, now(), $3, $4)
        RETURNING
          id,
          version_number AS "versionNumber",
          effective_from AS "effectiveFrom",
          change_summary AS "changeSummary"
      `,
      [nextVersionNumber, changeSummary, createdBy || null],
    )
    const version = versionRows[0]

    for (const item of nextItems) {
      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO scoring_scale_version_items (
            version_id, criterion_id, criterion_name, max_score
          )
          SELECT $2, $3, $4, $5
          WHERE EXISTS (
            SELECT 1 FROM scoring_scale_versions sv
            WHERE sv.id = $2 AND sv.tenant_id = $1
          )
        `,
        [version.id, item.criterionId, item.name, item.maxPoints],
      )
    }

    return {
      version,
      criteria: nextItems.map((i) => ({
        id: i.criterionId,
        name: i.name,
        maxPoints: i.maxPoints,
      })),
      pointsTotal: 100,
    }
  })
}

async function assertScoreableStaff(tenantId, staffId, branchId, actorUserId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        s.id,
        s.user_id AS "userId",
        s.branch_id AS "branchId",
        s.status,
        u.full_name AS "fullName",
        s.image_url AS "imageUrl",
        s.designation_id AS "designationId",
        COALESCE(d.name, s.designation) AS designation,
        r.slug AS role,
        b.name AS "branchName"
      FROM staff s
      LEFT JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id
      LEFT JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND s.id = $2
        AND s.branch_id = $3
      LIMIT 1
    `,
    [staffId, branchId],
  )
  if (!rows.length) throw httpError(404, 'Staff member not found')
  const target = rows[0]
  const isSelf =
    target.userId && actorUserId && String(target.userId) === String(actorUserId)
  const isBranchManager =
    target.role === ROLES.BRANCH_MANAGER ||
    /branch\s*manager/i.test(String(target.designation || ''))
  if (isSelf || isBranchManager) {
    throw httpError(403, 'Branch managers cannot be scored in Performance Roster')
  }
  return target
}

// Append-only evaluation against the active scale version
export async function createEvaluation(
  tenantId,
  { staffId, branchId, remarks, items, createdBy },
) {
  const target = await assertScoreableStaff(tenantId, staffId, branchId, createdBy)
  if (String(target.status || '').toLowerCase() !== 'active') {
    throw httpError(403, 'Cannot score a deactivated employee')
  }

  const active = await getActiveScale(tenantId)
  if (!active.version || !active.criteria.length) {
    throw httpError(400, 'Configure a scoring scale (maxes must total 100) before evaluating')
  }
  if (active.pointsTotal !== 100) {
    throw httpError(400, 'Active scoring scale must total exactly 100 points')
  }

  const byId = new Map((items || []).map((row) => [row.criterionId, Number(row.points)]))
  const snapshotItems = []
  let actualTotal = 0
  let maxTotal = 0

  for (const criterion of active.criteria) {
    const raw = byId.has(criterion.id) ? byId.get(criterion.id) : 0
    const points = Number.isFinite(raw) && raw >= 0 ? raw : 0
    if (points > Number(criterion.maxPoints)) {
      throw httpError(
        400,
        `Points for "${criterion.name}" cannot exceed ${criterion.maxPoints}`,
      )
    }
    if (!Number.isInteger(points)) {
      throw httpError(400, 'Points must be whole numbers')
    }
    snapshotItems.push({
      criterionId: criterion.id,
      criterionName: criterion.name,
      maxScore: Number(criterion.maxPoints),
      points,
    })
    actualTotal += points
    maxTotal += Number(criterion.maxPoints)
  }

  const totalScore = round2((actualTotal / maxTotal) * 100)
  const ratingLabel = ratingLabelFromScore(totalScore)

  return withTransaction(async (client) => {
    const { rows } = await tenantClientQuery(
      client,
      tenantId,
      `
        INSERT INTO performance_evaluations (
          tenant_id, staff_id, branch_id, scale_version_id,
          total_score, rating_label, remarks, scored_at, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
        RETURNING
          id,
          staff_id AS "staffId",
          total_score AS "totalScore",
          rating_label AS "ratingLabel",
          remarks,
          scored_at AS "scoredAt",
          scale_version_id AS "scaleVersionId"
      `,
      [
        staffId,
        branchId,
        active.version.id,
        totalScore,
        ratingLabel,
        remarks ? String(remarks).trim() || null : null,
        createdBy || null,
      ],
    )
    const evaluation = rows[0]

    for (const item of snapshotItems) {
      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO performance_evaluation_items (
            evaluation_id, criterion_id, criterion_name, max_score, points
          )
          SELECT $2, $3, $4, $5, $6
          WHERE EXISTS (
            SELECT 1 FROM performance_evaluations pe
            WHERE pe.id = $2 AND pe.tenant_id = $1
          )
        `,
        [
          evaluation.id,
          item.criterionId,
          item.criterionName,
          item.maxScore,
          item.points,
        ],
      )
    }

    return {
      ...evaluation,
      totalScore: Number(evaluation.totalScore),
      items: snapshotItems,
      employeeName: target.fullName,
    }
  })
}

export async function listRoster(tenantId, { branchId, actorUserId }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        s.id AS "staffId",
        s.user_id AS "userId",
        s.branch_id AS "branchId",
        u.full_name AS "fullName",
        s.image_url AS "imageUrl",
        s.designation_id AS "designationId",
        d.name AS designation,
        r.slug AS role,
        s.status,
        l.total_score AS "score",
        l.rating_label AS "ratingLabel",
        l.scored_at AS "lastScoredAt",
        p.total_score AS "previousScore"
      FROM staff s
      LEFT JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id
      LEFT JOIN LATERAL (
        SELECT pe.total_score, pe.rating_label, pe.scored_at, pe.id
        FROM performance_evaluations pe
        WHERE pe.tenant_id = s.tenant_id AND pe.staff_id = s.id
        ORDER BY pe.scored_at DESC, pe.id DESC
        LIMIT 1
      ) l ON true
      LEFT JOIN LATERAL (
        SELECT pe.total_score
        FROM performance_evaluations pe
        WHERE pe.tenant_id = s.tenant_id AND pe.staff_id = s.id
        ORDER BY pe.scored_at DESC, pe.id DESC
        OFFSET 1
        LIMIT 1
      ) p ON true
      WHERE s.tenant_id = $1
        AND s.branch_id = $2
        AND s.status = 'active'
        AND (r.slug IS NULL OR r.slug <> $3)
        AND ($4::uuid IS NULL OR s.user_id IS DISTINCT FROM $4::uuid)
        AND (d.name IS NULL OR d.name !~* 'branch\\s*manager')
        AND (s.designation IS NULL OR s.designation !~* 'branch\\s*manager')
      ORDER BY u.full_name ASC
    `,
    [branchId, ROLES.BRANCH_MANAGER, actorUserId || null],
  )

  return rows.map((row) => {
    const score = row.score == null ? null : Number(row.score)
    const previousScore = row.previousScore == null ? null : Number(row.previousScore)
    const delta =
      score == null || previousScore == null ? null : round2(score - previousScore)
    const trend = trendFromDelta(delta)
    return {
      staffId: row.staffId,
      userId: row.userId,
      branchId: row.branchId,
      fullName: row.fullName,
      imageUrl: row.imageUrl,
      designationId: row.designationId,
      designation: row.designation,
      role: row.role,
      status: row.status,
      score,
      rating: score,
      ratingLabel: row.ratingLabel || (score == null ? null : ratingLabelFromScore(score)),
      lastScoredAt: row.lastScoredAt || null,
      previousScore,
      ...trend,
    }
  })
}

async function loadEvaluations(tenantId, staffId, { fromIso = null } = {}) {
  // tenantQuery prepends tenant as $1 → staffId=$2, from=$3
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        pe.id,
        pe.total_score AS "totalScore",
        pe.rating_label AS "ratingLabel",
        pe.remarks,
        pe.scored_at AS "scoredAt",
        pe.scale_version_id AS "scaleVersionId",
        pe.branch_id AS "branchId",
        b.name AS "branchName",
        u.full_name AS "evaluatorName",
        sv.version_number AS "scaleVersionNumber",
        sv.change_summary AS "scaleChangeSummary",
        sv.effective_from AS "scaleEffectiveFrom"
      FROM performance_evaluations pe
      LEFT JOIN users u ON u.id = pe.created_by
      LEFT JOIN branches b ON b.id = pe.branch_id AND b.tenant_id = pe.tenant_id
      LEFT JOIN scoring_scale_versions sv ON sv.id = pe.scale_version_id
      WHERE pe.tenant_id = $1
        AND pe.staff_id = $2
        ${fromIso ? 'AND pe.scored_at >= $3' : ''}
      ORDER BY pe.scored_at ASC, pe.id ASC
    `,
    fromIso ? [staffId, fromIso] : [staffId],
  )
  return rows.map((row) => ({
    ...row,
    totalScore: Number(row.totalScore),
  }))
}

async function loadEvaluationItems(tenantId, evaluationIds) {
  if (!evaluationIds.length) return new Map()
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        pei.evaluation_id AS "evaluationId",
        pei.criterion_id AS "criterionId",
        pei.criterion_name AS "criterionName",
        pei.max_score AS "maxScore",
        pei.points
      FROM performance_evaluation_items pei
      INNER JOIN performance_evaluations pe
        ON pe.id = pei.evaluation_id
        AND pe.tenant_id = $1
      WHERE pei.evaluation_id = ANY($2::uuid[])
      ORDER BY pei.criterion_name ASC
    `,
    [evaluationIds],
  )
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.evaluationId) || []
    list.push({
      criterionId: row.criterionId,
      criterionName: row.criterionName,
      maxScore: Number(row.maxScore),
      points: Number(row.points),
      percentOfMax: pctOfMax(row.points, row.maxScore),
    })
    map.set(row.evaluationId, list)
  }
  return map
}

async function loadScaleMarkers(tenantId, staffId, fromIso) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        sv.id,
        sv.version_number AS "versionNumber",
        sv.effective_from AS "effectiveFrom",
        sv.change_summary AS "changeSummary"
      FROM scoring_scale_versions sv
      WHERE sv.tenant_id = $1
        AND sv.version_number > 1
        AND EXISTS (
          SELECT 1 FROM performance_evaluations pe
          WHERE pe.tenant_id = sv.tenant_id
            AND pe.staff_id = $2
        )
        ${fromIso ? 'AND sv.effective_from >= $3' : ''}
      ORDER BY sv.effective_from ASC
    `,
    fromIso ? [staffId, fromIso] : [staffId],
  )
  return rows.map((row) => ({
    versionId: row.id,
    versionNumber: row.versionNumber,
    effectiveFrom: row.effectiveFrom,
    label: `Scale updated (v${row.versionNumber})`,
    changeSummary: row.changeSummary || '',
  }))
}

function buildCriteriaBreakdown(latestItems, previousItems) {
  const prevMap = new Map((previousItems || []).map((i) => [i.criterionId, i]))
  return (latestItems || []).map((item) => {
    const prev = prevMap.get(item.criterionId)
    if (!prev) {
      return {
        ...item,
        previousPercentOfMax: null,
        deltaPercentOfMax: null,
        isNew: true,
      }
    }
    const delta = round2(item.percentOfMax - prev.percentOfMax)
    return {
      ...item,
      previousPercentOfMax: prev.percentOfMax,
      previousPoints: prev.points,
      previousMaxScore: prev.maxScore,
      deltaPercentOfMax: delta,
      isNew: false,
    }
  })
}

export async function getEmployeePerformanceDetail(
  tenantId,
  {
    staffId,
    branchId,
    range = '12M',
    timelinePage = 1,
    timelineLimit = 10,
  },
) {
  const { rows: staffRows } = await tenantQuery(
    tenantId,
    `
      SELECT
        s.id AS "staffId",
        s.user_id AS "userId",
        s.branch_id AS "branchId",
        s.status,
        u.full_name AS "fullName",
        s.image_url AS "imageUrl",
        s.designation_id AS "designationId",
        COALESCE(d.name, s.designation) AS designation,
        r.slug AS role,
        b.name AS "branchName"
      FROM staff s
      LEFT JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN designations d ON d.id = s.designation_id
      LEFT JOIN branches b ON b.id = s.branch_id AND b.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1
        AND s.id = $2
        AND s.branch_id = $3
      LIMIT 1
    `,
    [staffId, branchId],
  )
  if (!staffRows.length) throw httpError(404, 'Staff member not found')
  const employee = staffRows[0]

  const fromIso = rangeStartIso(range)
  const allEvals = await loadEvaluations(tenantId, staffId, { fromIso: null })
  const chartEvals = fromIso
    ? allEvals.filter((e) => new Date(e.scoredAt) >= new Date(fromIso))
    : allEvals

  const allIds = allEvals.map((e) => e.id)
  const itemsByEval = await loadEvaluationItems(tenantId, allIds)

  const enrichedAll = allEvals.map((ev, index) => {
    const prev = index > 0 ? allEvals[index - 1] : null
    const delta = prev == null ? null : round2(ev.totalScore - prev.totalScore)
    return {
      ...ev,
      items: itemsByEval.get(ev.id) || [],
      changeDelta: delta,
      changeDirection: trendFromDelta(delta).trendDirection,
      isFirst: prev == null,
    }
  })

  const chronological = enrichedAll
  const newestFirst = [...chronological].reverse()
  const latest = newestFirst[0] || null
  const previous = newestFirst[1] || null

  const page = Math.max(1, Number(timelinePage) || 1)
  const limit = Math.min(50, Math.max(1, Number(timelineLimit) || 10))
  const timelineTotal = newestFirst.length
  const timelineItems = newestFirst.slice((page - 1) * limit, page * limit)

  // Scale markers between timeline entries (version changes in range)
  const scaleMarkers = await loadScaleMarkers(tenantId, staffId, fromIso)

  const chartPoints = chartEvals.map((ev) => {
    const full = chronological.find((e) => e.id === ev.id)
    return {
      evaluationId: ev.id,
      scoredAt: ev.scoredAt,
      totalScore: ev.totalScore,
      ratingLabel: ev.ratingLabel,
      changeDelta: full?.changeDelta ?? null,
      changeDirection: full?.changeDirection ?? 'none',
      evaluatorName: ev.evaluatorName,
      isLatest: latest ? ev.id === latest.id : false,
    }
  })

  const scores = chronological.map((e) => e.totalScore)
  const averageScore = scores.length
    ? round2(scores.reduce((a, b) => a + b, 0) / scores.length)
    : null
  let best = null
  if (chronological.length) {
    best = chronological.reduce((acc, cur) =>
      cur.totalScore > acc.totalScore ? cur : acc,
    )
  }

  const change = latest
    ? previous
      ? {
          delta: round2(latest.totalScore - previous.totalScore),
          direction: trendFromDelta(latest.totalScore - previous.totalScore).trendDirection,
          previousScore: previous.totalScore,
          previousScoredAt: previous.scoredAt,
        }
      : { delta: null, direction: 'first', previousScore: null, previousScoredAt: null }
    : null

  return {
    employee: {
      staffId: employee.staffId,
      fullName: employee.fullName,
      imageUrl: employee.imageUrl,
      designation: employee.designation,
      designationId: employee.designationId,
      branchId: employee.branchId,
      branchName: employee.branchName,
      status: employee.status,
      canScore: String(employee.status || '').toLowerCase() === 'active',
    },
    summary: {
      currentScore: latest ? latest.totalScore : null,
      ratingLabel: latest ? latest.ratingLabel : null,
      change,
      lastScoredAt: latest ? latest.scoredAt : null,
      lastEvaluatorName: latest ? latest.evaluatorName : null,
      averageScore,
      bestScore: best ? best.totalScore : null,
      bestScoredAt: best ? best.scoredAt : null,
      evaluationCount: chronological.length,
    },
    chart: {
      range: String(range || '12M').toUpperCase(),
      points: chartPoints,
      scaleMarkers,
    },
    criteriaBreakdown: latest
      ? buildCriteriaBreakdown(latest.items, previous?.items || [])
      : [],
    previousCriteria: previous?.items || [],
    timeline: {
      page,
      limit,
      total: timelineTotal,
      pageCount: Math.max(1, Math.ceil(timelineTotal / limit) || 1),
      items: timelineItems,
      scaleMarkers,
    },
  }
}

// Dashboard / legacy callers — latest evaluation % (0 when never scored)
export const LATEST_EVALUATION_SCORE_SQL = `
  COALESCE(
    (
      SELECT pe.total_score
      FROM performance_evaluations pe
      WHERE pe.tenant_id = s.tenant_id
        AND pe.staff_id = s.id
      ORDER BY pe.scored_at DESC, pe.id DESC
      LIMIT 1
    ),
    0
  )
`
