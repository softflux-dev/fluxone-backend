import { z } from 'zod'
import { empty, idParams, paginationQuery } from '../shared.validator.js'

const orderStatusEnum = z.enum([
  'pending',
  'approved',
  'rejected',
  'partially_received',
  'received',
  'cancelled',
])

const orderLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative().optional(),
  scale: z.string().min(1).optional(),
})

const companyBlockSchema = z.object({
  supplierId: z.string().uuid(),
  lines: z.array(orderLineSchema).min(1),
})

const orderBodyBase = z
  .object({
    explanation: z.string().optional(),
    sendSms: z.coerce.boolean().optional(),
    // Legacy single-company shape (IM Generate Order dialog)
    supplierId: z.string().uuid().optional(),
    lines: z.array(orderLineSchema).min(1).optional(),
    // Multi-company shape (TL / Phase 4 page)
    companies: z.array(companyBlockSchema).min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const hasCompanies = Array.isArray(data.companies) && data.companies.length > 0
    const hasLegacy = Boolean(data.supplierId) && Array.isArray(data.lines) && data.lines.length > 0
    if (!hasCompanies && !hasLegacy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide companies[] or supplierId with lines[]',
        path: ['companies'],
      })
    }
  })

export const listOrdersSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: z.string().optional(),
    supplierId: z.string().uuid().optional(),
    status: orderStatusEnum.optional(),
  }),
})

export const generateOrderSchema = z.object({
  body: orderBodyBase,
  query: empty,
  params: empty,
})

export const updatePendingOrderSchema = z.object({
  body: orderBodyBase,
  query: empty,
  params: idParams,
})

export const rejectOrderSchema = z.object({
  body: z.object({
    rejectionNotes: z.string().max(2000).optional(),
    notes: z.string().max(2000).optional(),
  }),
  query: empty,
  params: idParams,
})

// TL §6.1 — multi-round receival lines
export const recordReceivalSchema = z.object({
  body: z.object({
    notes: z.string().max(2000).optional(),
    lines: z
      .array(
        z.object({
          purchaseOrderItemId: z.string().uuid(),
          quantity: z.coerce.number().positive(),
        }),
      )
      .min(1),
  }),
  query: empty,
  params: idParams,
})

export const orderIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

// TL §10 — nested invoice under purchase order
export const orderInvoiceParamsSchema = z.object({
  body: empty,
  query: empty,
  params: z.object({
    id: z.string().uuid(),
    invoiceId: z.string().uuid(),
  }),
})

// Client builds PDF (jspdf) and posts base64 for nodemailer attachment
export const sendOrderInvoiceSchema = z.object({
  body: z.object({
    pdfBase64: z.string().min(32, 'PDF attachment is required'),
    filename: z.string().max(180).optional(),
  }),
  query: empty,
  params: z.object({
    id: z.string().uuid(),
    invoiceId: z.string().uuid(),
  }),
})
