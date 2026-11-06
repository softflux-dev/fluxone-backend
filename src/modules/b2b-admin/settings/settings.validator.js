import { z } from 'zod'
import {
  empty,
  optionalString,
  optionalUuid,
  paginationQuery,
} from '../../branch-manager/shared.validator.js'
import { SUPPORTED_CURRENCIES } from '../../../utils/currency.util.js'
import { looseUuidWithMessage } from '../../../utils/zodFields.util.js'

const currencyCodes = SUPPORTED_CURRENCIES.map((c) => c.code)

const looseUuid = looseUuidWithMessage('Invalid device id')

const HARDWARE_TYPES = ['Computers', 'Scanners', 'Printers', 'Telephone', 'Other']

export const listDevicesQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: optionalString,
    branchId: optionalUuid,
    // Hardware type filter (matches branch_hardware.type)
    type: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? 'all' : value),
      z.enum(['all', ...HARDWARE_TYPES]).default('all'),
    ),
    status: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? 'all' : value),
      z.enum(['all', 'active', 'blocked']).default('all'),
    ),
  }),
})

export const deviceIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})

export const updateDeviceStatusSchema = z.object({
  body: z.object({
    status: z.enum(['active', 'blocked']),
  }),
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})

export const getCurrencySchema = z.object({
  body: empty,
  params: empty,
  query: empty,
})

export const updateCurrencySchema = z.object({
  body: z.object({
    defaultCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => currencyCodes.includes(v), {
        message: `Currency must be one of: ${currencyCodes.join(', ')}`,
      }),
    // PKR per 1 unit of defaultCurrency (e.g. 1 USD = 230 PKR → 230). Required when not PKR.
    rateToPkr: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
  }),
  params: empty,
  query: empty,
})
