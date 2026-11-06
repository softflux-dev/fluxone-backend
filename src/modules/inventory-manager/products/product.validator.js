import { z } from 'zod'
import { PRODUCT_STATUS, PRODUCT_TYPES } from '../../../config/constants.js'
import {
  catalogFilters,
  empty,
  idParams,
  looseUuid,
  nullableLooseUuid,
  optionalBool,
  optionalLooseUuid,
  optionalPercentField,
  paginationQuery,
} from '../shared.validator.js'

export const listCatalogSchema = z.object({
  body: empty,
  params: empty,
  query: catalogFilters.merge(paginationQuery),
})

// Category 50 / subcategory 60 — enforced on create and update
const CATEGORY_NAME_MAX = 50
const SUBCATEGORY_NAME_MAX = 60

export const createCategorySchema = z.object({
  body: z
    .object({
      name: z.string().min(1),
      parentId: optionalLooseUuid,
    })
    .superRefine((body, ctx) => {
      const max = body.parentId ? SUBCATEGORY_NAME_MAX : CATEGORY_NAME_MAX
      if (body.name.trim().length > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: max,
          type: 'string',
          inclusive: true,
          path: ['name'],
          message: `Name must be at most ${max} characters`,
        })
      }
    }),
  query: empty,
  params: empty,
})

export const updateCategorySchema = z.object({
  body: z.object({
    // Absolute ceiling; write layer applies 50 vs 60 from parent_id
    name: z.string().min(1).max(SUBCATEGORY_NAME_MAX).optional(),
    isActive: z.coerce.boolean().optional(),
  }),
  query: empty,
  params: idParams,
})

export const categoryIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const setCategoryActiveSchema = z.object({
  body: z.object({
    isActive: z.coerce.boolean(),
  }),
  query: empty,
  params: idParams,
})

// Combination parts — typeId/valueId may be catalog UUIDs or custom temp ids
const variantPartSchema = z.object({
  typeId: z.string().min(1).optional(),
  typeName: z.string().min(1),
  valueId: z.string().min(1).optional(),
  valueName: z.string().min(1),
  isCustomType: optionalBool,
  isCustomValue: optionalBool,
})

// Money = non-negative whole units (UI / POS show 100, not 100.10)
const moneyField = z.coerce
  .number()
  .nonnegative()
  .transform((n) => Math.round(n))

const optionalDiscountPercent = z.preprocess(
  (v) => (v === '' || v === undefined ? undefined : v === null ? null : v),
  z.coerce.number().int().min(0).max(100).nullable().optional(),
)

function sellingGtePurchase(purchase, selling) {
  if (purchase == null || selling == null) return true
  return Number(selling) >= Number(purchase)
}

const variantSkuSchema = z
  .object({
    label: z.string().min(1),
    itemCode: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    // Optional — server generates when omitted (same as single-item create)
    barcode: z.string().min(1).optional(),
    purchasePrice: moneyField,
    sellingPrice: moneyField,
    quantity: z.coerce.number().int().nonnegative().optional().default(0),
    reorderPoint: z.coerce.number().int().nonnegative().optional(),
    dailyPriceChange: optionalBool,
    offerId: nullableLooseUuid,
    discountPercent: optionalDiscountPercent,
    status: z
      .enum([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.INACTIVE])
      .optional()
      .default(PRODUCT_STATUS.ACTIVE),
    parts: z.array(variantPartSchema).min(1),
  })
  .refine((row) => sellingGtePurchase(row.purchasePrice, row.sellingPrice), {
    message: 'Selling price must be greater than or equal to purchase price',
    path: ['sellingPrice'],
  })

export const createProductSchema = z
  .object({
    body: z.object({
      name: z.string().min(1),
      categoryId: optionalLooseUuid,
      subcategoryId: optionalLooseUuid,
      type: z
        .enum([PRODUCT_TYPES.SINGLE, PRODUCT_TYPES.BUNDLE, PRODUCT_TYPES.VARIANT])
        .default(PRODUCT_TYPES.SINGLE),
      scale: z.string().min(1).optional().default('unit'),
      description: z.string().optional(),
      // Optional — system generates when omitted
      itemCode: z.string().min(1).optional(),
      sku: z.string().min(1).optional(),
      barcode: z.string().min(1).optional(),
      purchasePrice: moneyField.optional(),
      sellingPrice: moneyField.optional(),
      taxIds: z.array(looseUuid).optional(),
      // IM: Admin default rate only (or omit → tenant default). Custom % rejected in product.write.
      taxPercent: optionalPercentField,
      // Ignored on create (tenant default). Admin bulk owns profit % changes.
      profitPercent: optionalPercentField,
      offerId: optionalLooseUuid,
      discountPercent: optionalDiscountPercent,
      confirmed: z.coerce.boolean().optional(),
      // Opening stock (single) or finished bundle count
      quantity: z.number().nonnegative().optional(),
      status: z.enum([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.INACTIVE]).optional(),
      reorderPoint: z.number().nonnegative().optional(),
      dailyPriceChange: optionalBool,
      bundleItems: z
        .array(
          z.object({
            itemId: looseUuid,
            quantity: z.number().positive(),
          }),
        )
        .optional(),
      variants: z.array(variantSkuSchema).optional(),
    }),
    query: empty,
    params: empty,
  })
  .refine(
    ({ body }) => body.type !== PRODUCT_TYPES.BUNDLE || (body.bundleItems && body.bundleItems.length >= 2),
    {
      message: 'A bundle must contain at least 2 items',
      path: ['body', 'bundleItems'],
    },
  )
  .refine(
    ({ body }) => {
      if (body.type !== PRODUCT_TYPES.BUNDLE || !body.bundleItems) return true
      const ids = body.bundleItems.map((row) => row.itemId)
      return new Set(ids).size === ids.length
    },
    {
      message: 'The same item cannot be added twice. Increase quantity on the existing row.',
      path: ['body', 'bundleItems'],
    },
  )
  .refine(
    ({ body }) => body.type !== PRODUCT_TYPES.BUNDLE || Number(body.sellingPrice) > 0,
    {
      message: 'Bundle price is required and cannot be zero',
      path: ['body', 'sellingPrice'],
    },
  )
  .refine(
    ({ body }) =>
      body.type !== PRODUCT_TYPES.BUNDLE ||
      (body.quantity !== undefined && Number(body.quantity) >= 1),
    {
      message: 'Bundle Quantity must be at least 1 when creating a bundle',
      path: ['body', 'quantity'],
    },
  )
  .refine(
    ({ body }) => body.type === PRODUCT_TYPES.BUNDLE || Boolean(body.categoryId),
    {
      message: 'categoryId is required for single and variant items',
      path: ['body', 'categoryId'],
    },
  )
  .refine(
    ({ body }) =>
      body.type !== PRODUCT_TYPES.VARIANT || (Array.isArray(body.variants) && body.variants.length > 0),
    {
      message: 'Variant products require at least one combination (variants)',
      path: ['body', 'variants'],
    },
  )
  .refine(
    ({ body }) =>
      body.type === PRODUCT_TYPES.VARIANT ||
      body.type === PRODUCT_TYPES.BUNDLE ||
      sellingGtePurchase(body.purchasePrice, body.sellingPrice),
    {
      message: 'Selling price must be greater than or equal to purchase price',
      path: ['body', 'sellingPrice'],
    },
  )

export const importItemsSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z.object({
          rowKind: z.enum(['product', 'variant', 'bundle_item']).optional().default('product'),
          // File-local refs for variant/bundle linking (itemCode is never imported — server generates)
          importRef: z.string().optional(),
          parentRef: z.string().optional(),
          componentRef: z.string().optional(),
          // Legacy aliases still accepted then ignored for identity (mapped to refs server-side)
          sku: z.string().optional(),
          itemCode: z.string().optional(),
          parentItemCode: z.string().optional(),
          componentItemCode: z.string().optional(),
          name: z.string().optional(),
          barcode: z.string().optional(),
          type: z
            .enum([PRODUCT_TYPES.SINGLE, PRODUCT_TYPES.BUNDLE, PRODUCT_TYPES.VARIANT])
            .optional(),
          scale: z.string().optional(),
          status: z.enum(['active', 'inactive', 'open', 'close']).optional(),
          category: z.string().optional(),
          subcategory: z.string().optional(),
          quantity: z.coerce.number().nonnegative().optional(),
          purchasePrice: z.coerce.number().nonnegative().optional(),
          sellingPrice: z.coerce.number().nonnegative().optional(),
          reorderPoint: z.coerce.number().nonnegative().optional(),
          description: z.string().optional(),
          discountPercent: z.coerce.number().nonnegative().optional(),
          offerName: z.string().optional(),
          taxPercent: z.coerce.number().nonnegative().optional(),
          dailyPriceChange: z
            .union([z.boolean(), z.string(), z.number()])
            .optional()
            .transform((v) => {
              if (v === true || v === 1 || v === '1') return true
              if (v === false || v === 0 || v === '0') return false
              if (typeof v === 'string') {
                const s = v.trim().toLowerCase()
                if (['true', 'yes', 'y'].includes(s)) return true
                if (['false', 'no', 'n'].includes(s)) return false
              }
              return undefined
            }),
          variantLabel: z.string().optional(),
          variantOptions: z.string().optional(),
          componentQty: z.coerce.number().positive().optional(),
        }),
      )
      .min(1),
  }),
  query: empty,
  params: empty,
})

export const exportItemsSchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const scanItemSchema = z.object({
  body: z.object({
    barcode: z.string().min(4),
  }),
  query: empty,
  params: empty,
})

export const productIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const deleteProductSchema = z.object({
  body: empty,
  query: z.object({
    permanent: optionalBool,
  }),
  params: idParams,
})

const variantSkuUpdateSchema = z
  .object({
    id: optionalLooseUuid,
    label: z.string().min(1),
    itemCode: z.string().min(1).optional(),
    sku: z.string().min(1).optional(),
    // Optional for new child SKUs — server generates when omitted
    barcode: z.string().min(1).optional(),
    purchasePrice: moneyField,
    sellingPrice: moneyField,
    // Opening stock only for NEW child SKUs (existing stock via Control)
    quantity: z.coerce.number().int().nonnegative().optional(),
    reorderPoint: z.coerce.number().int().nonnegative().optional(),
    dailyPriceChange: optionalBool,
    offerId: nullableLooseUuid,
    discountPercent: optionalDiscountPercent,
    status: z.enum([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.INACTIVE]).optional(),
    parts: z.array(variantPartSchema).min(1),
  })
  .refine((row) => sellingGtePurchase(row.purchasePrice, row.sellingPrice), {
    message: 'Selling price must be greater than or equal to purchase price',
    path: ['sellingPrice'],
  })

export const updateProductSchema = z
  .object({
    body: z.object({
      name: z.string().min(1).optional(),
      categoryId: optionalLooseUuid,
      subcategoryId: nullableLooseUuid,
      type: z
        .enum([PRODUCT_TYPES.SINGLE, PRODUCT_TYPES.BUNDLE, PRODUCT_TYPES.VARIANT])
        .optional(),
      // type may be sent by clients but updateProduct rejects mismatches (locked after create)
      status: z
        .enum([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.INACTIVE, 'open', 'close'])
        .optional()
        .transform((value) => {
          if (value === undefined) return undefined
          if (value === 'open') return PRODUCT_STATUS.ACTIVE
          if (value === 'close') return PRODUCT_STATUS.INACTIVE
          return value
        }),
      sellingPrice: moneyField.optional(),
      purchasePrice: moneyField.optional(),
      itemCode: z.string().min(1).optional(),
      sku: z.string().min(1).optional(),
      barcode: z.string().min(1).optional(),
      reorderPoint: z.coerce.number().int().nonnegative().optional(),
      dailyPriceChange: optionalBool,
      discountPercent: optionalDiscountPercent,
      offerId: nullableLooseUuid,
      description: z.string().optional(),
      scale: z.string().min(1).optional(),
      taxIds: z.array(looseUuid).optional(),
      // IM: Admin default rate only when set. Custom % rejected in product.write.
      taxPercent: optionalPercentField,
      // Ignored on update — Admin Tax & Profit bulk owns profit % changes
      profitPercent: optionalPercentField,
      // Finished bundle stock — changing this assembles / disassembles components
      quantity: z.coerce.number().int().nonnegative().optional(),
      bundleItems: z
        .array(
          z.object({
            itemId: looseUuid,
            quantity: z.coerce.number().int().positive(),
          }),
        )
        .optional(),
      variants: z.array(variantSkuUpdateSchema).optional(),
    }),
    query: empty,
    params: idParams,
  })
  // Bundle recipe is locked after create — do not require / accept bundleItems on update
  .refine(
    ({ body }) => {
      if (body.purchasePrice == null || body.sellingPrice == null) return true
      return sellingGtePurchase(body.purchasePrice, body.sellingPrice)
    },
    {
      message: 'Selling price must be greater than or equal to purchase price',
      path: ['body', 'sellingPrice'],
    },
  )
