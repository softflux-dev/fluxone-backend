import { Router } from 'express'
import dashboardRoutes from './dashboard/dashboard.routes.js'
import productRoutes from './products/product.routes.js'
import controlRoutes from './control/control.routes.js'
import supplierRoutes from './suppliers/supplier.routes.js'
import purchaseOrderRoutes from './purchase-orders/purchase_order.routes.js'
import reportRoutes from './reports/report.routes.js'
import lookupRoutes from './lookups/lookup.routes.js'

const router = Router()

router.use('/dashboard', dashboardRoutes)
router.use('/products', productRoutes)
router.use('/control', controlRoutes)
router.use('/suppliers', supplierRoutes)
router.use('/purchase-orders', purchaseOrderRoutes)
router.use('/reports', reportRoutes)
router.use('/lookups', lookupRoutes)

export default router
