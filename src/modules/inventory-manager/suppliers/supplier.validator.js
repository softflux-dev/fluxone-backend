import { z } from 'zod'
import { activeFilter, empty, idParams, optionalBool, paginationQuery } from '../shared.validator.js'

export const listSuppliersSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: z.string().optional(),
    active: activeFilter,
  }),
})

// TL §2.1 required fields (supplier = company)
const supplierBody = z.object({
  companyName: z.string().min(1, 'Company name is required'),
  companyPhone: z.string().min(1, 'Company contact number is required'),
  representativeName: z.string().min(1, 'Representative name is required'),
  representativePhone: z.string().min(1, 'Representative contact number is required'),
  representativeEmail: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().email('Valid representative email is required'),
  ),
  location: z.string().min(1, 'Company location is required'),
  taxPaid: optionalBool,
  registrationNumber: z.string().min(1, 'Registration number is required'),
  bankAccountNumber: z.string().optional(),
})

export const createSupplierSchema = z.object({
  body: supplierBody,
  query: empty,
  params: empty,
})

export const updateSupplierSchema = z.object({
  body: supplierBody.partial(),
  query: empty,
  params: idParams,
})

export const supplierIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const setSupplierActiveSchema = z.object({
  body: z.object({
    isActive: z.coerce.boolean(),
  }),
  query: empty,
  params: idParams,
})
