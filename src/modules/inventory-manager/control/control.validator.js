import { z } from 'zod'
import {
  catalogFilters,
  empty,
  idParams,
  optionalUuid,
  paginationQuery,
} from '../shared.validator.js'

// Empty string → omitted so date / label query params stay optional.
const optionalDateString = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .optional(),
)

const optionalText = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.string().optional(),
)

// Scale optional — SKU is selected via product / variant axes; server defaults from product.
const optionalScale = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.string().min(1).optional(),
)

const ledgerKindEnum = z.enum(['adjustment', 'damaged', 'expired', 'other'])

export const listLedgerSchema = z.object({
  body: empty,
  params: empty,
  query: catalogFilters.merge(paginationQuery).extend({
    movementType: z.string().optional(),
    ledgerKind: ledgerKindEnum.optional(),
    productId: optionalUuid,
    from: optionalDateString,
    to: optionalDateString,
    variantLabel: optionalText,
    variantTypeId: optionalUuid,
    variantValueId: optionalUuid,
  }),
})

// Summary shares list filters (no pagination).
export const controlSummarySchema = z.object({
  body: empty,
  params: empty,
  query: catalogFilters
    .omit({ status: true })
    .extend({
      productId: optionalUuid,
      from: optionalDateString,
      to: optionalDateString,
      variantLabel: optionalText,
      variantTypeId: optionalUuid,
      variantValueId: optionalUuid,
    }),
})

export const stockInSchema = z.object({
  body: z.object({
    supplierId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    lines: z
      .array(
        z.object({
          productId: z.string().uuid(),
          scale: optionalScale,
          quantity: z.coerce.number().int().positive(),
          unitCost: z.coerce.number().int().nonnegative().optional(),
          sellingPrice: z.coerce.number().nonnegative().optional(),
          expiresAt: z.coerce.date().optional(),
          reason: z.string().min(1).max(2000).optional(),
          // Adjustment dialog stock-in → dual-list on Adjustment tab
          controlSource: z.enum(['adjustment']).optional(),
        }),
      )
      .min(1),
  }),
  query: empty,
  params: empty,
})

export const stockInFromOrderSchema = z.object({
  body: z.object({
    purchaseOrderId: z.string().uuid(),
  }),
  query: empty,
  params: empty,
})

export const stockMovementSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().int(),
    scale: optionalScale,
    reason: z.string().min(3).optional(),
    supplierId: z.string().uuid().optional(),
    damagedByUserId: z.string().uuid().optional(),
    damagedLocation: z.enum(['traveling', 'warehouse', 'item_transfer', 'other']).optional(),
  }),
  query: empty,
  params: empty,
})

export const adjustmentSchema = stockMovementSchema.extend({
  body: stockMovementSchema.shape.body.extend({
    reason: z.string().min(3),
    quantity: z.coerce.number().int().refine((n) => n !== 0, 'Adjustment quantity cannot be zero'),
  }),
})

// Others — signed qty + required reason (misc stock movements).
export const otherSchema = stockMovementSchema.extend({
  body: stockMovementSchema.shape.body.extend({
    reason: z.string().min(3),
    quantity: z.coerce.number().int().refine((n) => n !== 0, 'Other quantity cannot be zero'),
  }),
})

export const damagedSchema = stockMovementSchema.extend({
  body: stockMovementSchema.shape.body.extend({
    damagedByUserId: z.string().uuid(),
    damagedLocation: z.enum(['traveling', 'warehouse', 'item_transfer', 'other']),
    reason: z.string().min(3),
    quantity: z.coerce.number().int().positive(),
  }),
})

export const stockOutSchema = stockMovementSchema.extend({
  body: stockMovementSchema.shape.body.extend({
    quantity: z.coerce.number().int().positive(),
  }),
})

export const expiredSchema = stockMovementSchema.extend({
  body: stockMovementSchema.shape.body.extend({
    quantity: z.coerce.number().int().positive(),
    expiresAt: z.coerce.date(),
    supplierId: z.string().uuid().optional(),
    reason: z.string().min(3).optional(),
  }),
})

export const transferSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    fromBranchId: z.string().uuid(),
    toBranchId: z.string().uuid(),
    quantity: z.coerce.number().int().positive(),
    scale: optionalScale,
    reason: z.string().min(3).optional(),
  }),
  query: empty,
  params: empty,
})

export const ledgerIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const patchMovementSchema = z.object({
  body: z.object({
    quantity: z.coerce
      .number()
      .int()
      .refine((n) => n !== 0, 'Quantity cannot be zero')
      .optional(),
    reason: z.string().min(3).optional(),
    damagedByUserId: z.string().uuid().optional(),
    damagedLocation: z.enum(['traveling', 'warehouse', 'item_transfer', 'other']).optional(),
    expiresAt: z.coerce.date().optional(),
    supplierId: z.string().uuid().optional(),
  }),
  query: empty,
  params: idParams,
})

// Phase 4 — thresholds / alerts / daily prices
export const listThresholdsSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    q: optionalText,
  }),
})

export const upsertThresholdSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    reorderPoint: z.coerce.number().int().nonnegative(),
  }),
  query: empty,
  params: empty,
})

export const thresholdProductParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const updateDailyPriceSchema = z.object({
  body: z.object({
    purchasePrice: z.coerce.number().nonnegative(),
    sellingPrice: z.coerce.number().nonnegative(),
  }),
  query: empty,
  params: idParams,
})

// Phase 5 — export / import / price utilization rule
export const exportLedgerSchema = z.object({
  body: empty,
  params: empty,
  query: catalogFilters.merge(
    z.object({
      // adjustment = unified ledger (adjustment + damaged + expired + other)
      movementType: z.enum([
        'in',
        'out',
        'adjustment',
        'damaged',
        'expired',
        'other',
      ]),
      ledgerKind: ledgerKindEnum.optional(),
      productId: optionalUuid,
      from: optionalDateString,
      to: optionalDateString,
      variantLabel: optionalText,
      variantTypeId: optionalUuid,
      variantValueId: optionalUuid,
    }),
  ),
})

export const importControlSchema = z.object({
  body: z.object({
    movementType: z.enum(['in', 'adjustment', 'damaged', 'other']),
    rows: z
      .array(
        z.object({
          itemCode: z.string().optional(),
          barcode: z.string().optional(),
          quantity: z.coerce.number(),
          scale: z.string().optional(),
          reason: z.string().optional(),
          notes: z.string().optional(),
          variantType: z.string().optional(),
          variantValue: z.string().optional(),
          variantLabel: z.string().optional(),
          unitCost: z.coerce.number().optional(),
          damagedByEmail: z.preprocess(
            (value) => (value === '' || value == null ? undefined : value),
            z.string().email().optional(),
          ),
          damagedLocation: z.preprocess(
            (value) => (value === '' || value == null ? undefined : value),
            z.enum(['traveling', 'warehouse', 'item_transfer', 'other']).optional(),
          ),
        }),
      )
      .min(1)
      .max(1000),
  }),
  query: empty,
  params: empty,
})

export const priceRuleSchema = z.object({
  body: empty,
  params: empty,
  query: empty,
})

export const branchPriceRulePatchSchema = z.object({
  body: z.object({
    updateAllStock: z.boolean(),
  }),
  query: empty,
  params: empty,
})

export const patchPriceRuleSchema = z.object({
  body: z.object({
    priceRequiresStockUtilized: z.boolean(),
  }),
  query: empty,
  params: empty,
})
