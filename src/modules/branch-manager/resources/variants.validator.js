import { z } from 'zod'
import { empty, idParams, optionalString, optionalUuid } from '../shared.validator.js'

const activeFilter = z.enum(['active', 'inactive', 'all']).optional().default('all')

const nameField = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(80, 'Name must be 80 characters or less')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9 ._\-\/%]*$/,
    'Name may only contain letters, numbers, spaces, and . _ - / %',
  )

const booleanField = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === '1') return true
    if (lower === 'false' || lower === '0') return false
  }
  return value
}, z.boolean())

const includeValuesField = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    if (lower === 'true' || lower === '1') return true
    if (lower === 'false' || lower === '0') return false
  }
  return value
}, z.boolean().default(false))

export const listVariantTypesSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    q: optionalString,
    active: activeFilter,
    includeValues: includeValuesField,
    branchId: optionalUuid,
  }),
})

export const createVariantTypeSchema = z.object({
  body: z.object({
    name: nameField,
    isActive: booleanField.optional().default(true),
    branchId: optionalUuid,
  }),
  query: empty,
  params: empty,
})

export const updateVariantTypeSchema = z.object({
  body: z
    .object({
      name: nameField.optional(),
      isActive: booleanField.optional(),
      branchId: optionalUuid,
    })
    .refine((data) => data.name !== undefined || data.isActive !== undefined, {
      message: 'At least one of name or isActive is required',
    }),
  query: empty,
  params: idParams,
})

export const variantTypeIdParamsSchema = z.object({
  body: empty,
  query: z.object({ branchId: optionalUuid }),
  params: idParams,
})

export const listVariantValuesSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    q: optionalString,
    variantTypeId: optionalUuid,
    active: activeFilter,
    branchId: optionalUuid,
  }),
})

export const createVariantValueSchema = z.object({
  body: z.object({
    variantTypeId: z.string().uuid('Invalid variant type'),
    name: nameField,
    isActive: booleanField.optional().default(true),
    branchId: optionalUuid,
  }),
  query: empty,
  params: empty,
})

export const updateVariantValueSchema = z.object({
  body: z
    .object({
      variantTypeId: z.string().uuid('Invalid variant type').optional(),
      name: nameField.optional(),
      isActive: booleanField.optional(),
      branchId: optionalUuid,
    })
    .refine(
      (data) =>
        data.name !== undefined ||
        data.isActive !== undefined ||
        data.variantTypeId !== undefined,
      { message: 'At least one of name, isActive, or variantTypeId is required' },
    ),
  query: empty,
  params: idParams,
})

export const variantValueIdParamsSchema = z.object({
  body: empty,
  query: z.object({ branchId: optionalUuid }),
  params: idParams,
})
