import { hasPermission } from '../config/constants.js'
import { error } from '../utils/response.util.js'

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user?.role) {
      return error(res, 'Authentication required', 401)
    }
    if (!roles.includes(req.user.role)) {
      return error(res, 'You do not have access to this resource', 403)
    }
    next()
  }
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user?.role) {
      return error(res, 'Authentication required', 401)
    }
    if (!hasPermission(req.user.role, permission)) {
      return error(res, 'You do not have permission to perform this action', 403)
    }
    next()
  }
}
