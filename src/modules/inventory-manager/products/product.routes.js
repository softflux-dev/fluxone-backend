import { Router } from 'express'
import {
  addBundle,
  addCategory,
  addProduct,
  categories,
  categoryDependencies,
  detail,
  deleteInfo,
  exportItems,
  importItems,
  offers,
  patchCategory,
  printBarcode,
  products,
  remove,
  removeCategory,
  scan,
  taxes,
  taxProfitDefaults,
  update,
} from './product.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { upload } from '../../../middlewares/upload.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  categoryIdParamsSchema,
  createCategorySchema,
  createProductSchema,
  deleteProductSchema,
  exportItemsSchema,
  importItemsSchema,
  listCatalogSchema,
  productIdParamsSchema,
  scanItemSchema,
  updateCategorySchema,
  updateProductSchema,
} from './product.validator.js'

const router = Router()

router.get('/categories', requirePermission('items:read'), asyncHandler(categories))
router.get('/taxes', requirePermission('items:read'), asyncHandler(taxes))
router.get('/tax-profit-defaults', requirePermission('items:read'), asyncHandler(taxProfitDefaults))
router.get('/offers', requirePermission('items:read'), asyncHandler(offers))
router.post(
  '/categories',
  requirePermission('items:write'),
  upload.single('image'),
  validate(createCategorySchema),
  asyncHandler(addCategory),
)
router.post(
  '/subcategories',
  requirePermission('items:write'),
  upload.single('image'),
  validate(createCategorySchema),
  asyncHandler(addCategory),
)
router.patch(
  '/categories/:id',
  requirePermission('items:write'),
  upload.single('image'),
  validate(updateCategorySchema),
  asyncHandler(patchCategory),
)
router.get(
  '/categories/:id/dependencies',
  requirePermission('items:read'),
  validate(categoryIdParamsSchema),
  asyncHandler(categoryDependencies),
)
router.delete(
  '/categories/:id',
  requirePermission('items:write'),
  validate(categoryIdParamsSchema),
  asyncHandler(removeCategory),
)

router.get('/', requirePermission('items:read'), validate(listCatalogSchema), asyncHandler(products))
router.get(
  '/export',
  requirePermission('items:read'),
  validate(exportItemsSchema),
  asyncHandler(exportItems),
)
router.post(
  '/',
  requirePermission('items:write'),
  upload.single('image'),
  validate(createProductSchema),
  asyncHandler(addProduct),
)
router.post(
  '/bundles',
  requirePermission('items:write'),
  upload.single('image'),
  validate(createProductSchema),
  asyncHandler(addBundle),
)
router.post('/import', requirePermission('items:write'), validate(importItemsSchema), asyncHandler(importItems))
router.post('/scan', requirePermission('items:read'), validate(scanItemSchema), asyncHandler(scan))
router.get('/:id/delete-info', requirePermission('items:read'), validate(productIdParamsSchema), asyncHandler(deleteInfo))
router.get('/:id', requirePermission('items:read'), validate(productIdParamsSchema), asyncHandler(detail))
router.get(
  '/:id/barcode',
  requirePermission('items:read'),
  validate(productIdParamsSchema),
  asyncHandler(printBarcode),
)
router.patch(
  '/:id',
  requirePermission('items:write'),
  upload.single('image'),
  validate(updateProductSchema),
  asyncHandler(update),
)
router.delete(
  '/:id',
  requirePermission('items:write'),
  validate(deleteProductSchema),
  asyncHandler(remove),
)

export default router
