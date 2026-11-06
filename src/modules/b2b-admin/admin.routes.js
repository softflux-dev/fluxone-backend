import { Router } from 'express'
import { requireRoles } from '../../middlewares/role.middleware.js'
import { ROLES } from '../../config/constants.js'
import dashboardRoutes from './dashboard/dashboard.routes.js'
import branchesRoutes from './branches/branches.routes.js'
import companyRoutes from './company/company.routes.js'
import policiesRoutes from './policies/policies.routes.js'
import taxProfitRoutes from './tax-profit/tax-profit.routes.js'
import settingsRoutes from './settings/settings.routes.js'
import invoicesRoutes from './invoices/invoices.routes.js'
import leavesRoutes from './leaves/leaves.routes.js'
import logsRoutes from './logs/logs.routes.js'

const router = Router()

// All /api/admin/* require b2b_admin JWT (UI + PERMISSIONS are B2B-admin-only)
router.use(requireRoles(ROLES.B2B_ADMIN))
router.use('/dashboard', dashboardRoutes)
router.use('/branches', branchesRoutes)
router.use('/leaves', leavesRoutes)
router.use('/company', companyRoutes)
router.use('/policies', policiesRoutes)
router.use('/tax-profit', taxProfitRoutes)
router.use('/settings', settingsRoutes)
router.use('/invoices', invoicesRoutes)
router.use('/logs', logsRoutes)

export default router
