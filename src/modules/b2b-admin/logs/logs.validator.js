import { z } from 'zod'
import { empty, optionalString, optionalUuid, paginationQuery } from '../../branch-manager/shared.validator.js'
import { ACTIVITY_CATEGORIES, ACTIVITY_SOURCES } from '../../../utils/activityLog.util.js'
import { ADMIN_LOGS_MAX_RANGE_DAYS } from './logs.filterSql.js'

const optionalCategory = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(ACTIVITY_CATEGORIES).optional(),
)

/** Comma-separated categories for All Activity multi-select (Phase 4+). */
const optionalCategoriesCsv = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}, z.array(z.enum(ACTIVITY_CATEGORIES)).optional())

const optionalActionsCsv = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}, z.array(z.string().min(1)).optional())

const optionalIdsCsv = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}, z.array(z.string().uuid()).max(200).optional())

const optionalProductType = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['normal', 'variant']).optional(),
)

const optionalSettingCategory = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z
    .enum(['branch_settings', 'tax_configuration', 'policy', 'notification', 'other'])
    .optional(),
)

export const listAdminLogsQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery
    .extend({
      branchId: optionalUuid,
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      // Single category (tab) or multi (All Activity filter)
      category: optionalCategory,
      categories: optionalCategoriesCsv,
      actorRole: optionalString,
      actorUserId: optionalUuid,
      action: optionalString,
      actions: optionalActionsCsv,
      source: z.enum(ACTIVITY_SOURCES).optional(),
      q: optionalString,
      entityId: optionalUuid,
      productType: optionalProductType,
      variantTypeId: optionalUuid,
      supplierId: optionalUuid,
      orderStatus: optionalString,
      settingCategory: optionalSettingCategory,
      ids: optionalIdsCsv,
    })
    .superRefine((query, ctx) => {
      if (!query.from || !query.to) return
      const fromMs = new Date(query.from).getTime()
      const toMs = new Date(query.to).getTime()
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return
      if (toMs < fromMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '`to` must be on or after `from`',
          path: ['to'],
        })
        return
      }
      const spanDays = (toMs - fromMs) / (1000 * 60 * 60 * 24)
      if (spanDays > ADMIN_LOGS_MAX_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Date range cannot exceed ${ADMIN_LOGS_MAX_RANGE_DAYS} days`,
          path: ['to'],
        })
      }
    }),
})

export const adminLogActorsQuerySchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    branchId: z.string().uuid(),
    actorRole: optionalString,
  }),
})

export const adminLogFilterOptionsQuerySchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    branchId: z.string().uuid(),
    kind: z.enum(['products', 'bundles', 'suppliers', 'variant_types']),
    productType: optionalProductType,
  }),
})
