import { z } from 'zod'
import { empty, idParams } from '../shared.validator.js'

const criterionBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  maxPoints: z.coerce.number().int().min(1).max(100),
})

export const listScalesSchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const saveScaleSchema = z.object({
  body: z.object({
    criteria: z.array(criterionBody).min(1),
  }),
  query: empty,
  params: empty,
})

export const listScoresSchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const createEvaluationSchema = z.object({
  body: z.object({
    staffId: z.string().uuid(),
    remarks: z.string().trim().max(2000).optional().nullable(),
    items: z
      .array(
        z.object({
          criterionId: z.string().uuid(),
          points: z.coerce.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
  query: empty,
  params: empty,
})

export const employeeDetailSchema = z.object({
  body: empty,
  query: z.object({
    range: z.enum(['3M', '6M', '12M', 'All', 'all', '3m', '6m', '12m']).optional(),
    timelinePage: z.coerce.number().int().min(1).optional(),
    timelineLimit: z.coerce.number().int().min(1).max(50).optional(),
  }),
  params: z.object({
    staffId: z.string().uuid(),
  }),
})

// Legacy aliases kept so older route imports do not break during rollout
export const scoreStaffSchema = createEvaluationSchema
export const performanceSchema = createEvaluationSchema
export const createScaleSchema = saveScaleSchema
export const updateScaleSchema = saveScaleSchema
export const scaleIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
