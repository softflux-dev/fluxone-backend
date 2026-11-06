export const ROLES = {
  INVENTORY_MANAGER: 'inventory_manager',
  BRANCH_MANAGER: 'branch_manager',
  B2B_ADMIN: 'b2b_admin',
  CASHIER: 'cashier',
  BRANCH_ADMIN: 'branch_admin',
  PRODUCTION_STAFF: 'production_staff',
  DELIVERY_STAFF: 'delivery_staff',
  WEBSITE_MANAGER: 'website_manager',
}

export const ROLE_IDS = {
  [ROLES.INVENTORY_MANAGER]: 1,
  [ROLES.BRANCH_MANAGER]: 2,
  [ROLES.B2B_ADMIN]: 3,
  [ROLES.CASHIER]: 4,
  [ROLES.BRANCH_ADMIN]: 5,
  [ROLES.PRODUCTION_STAFF]: 6,
  [ROLES.DELIVERY_STAFF]: 7,
  [ROLES.WEBSITE_MANAGER]: 8,
}

// Password hashing work factor (bcrypt rounds)
export const BCRYPT_COST = 12

export const PRODUCT_TYPES = {
  SINGLE: 'single',
  BUNDLE: 'bundle',
  VARIANT: 'variant',
}

export const PRODUCT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  OPEN: 'active',
  CLOSE: 'inactive',
}

export const MOVEMENT_TYPES = {
  IN: 'in',
  OUT: 'out',
  ADJUSTMENT: 'adjustment',
  DAMAGED: 'damaged',
  EXPIRED: 'expired',
  TRANSFER: 'transfer',
  OTHER: 'other',
}

// Control UI origin — Adjustment dialog rows also list on Stock In / Stock Out tabs
export const CONTROL_SOURCES = {
  ADJUSTMENT: 'adjustment',
}

// Stock Out history = POS sales + Adjustment stock-out reasons
export const STOCK_OUT_LEDGER_TYPES = [
  MOVEMENT_TYPES.OUT,
  MOVEMENT_TYPES.DAMAGED,
  MOVEMENT_TYPES.EXPIRED,
  MOVEMENT_TYPES.OTHER,
]

// Adjustment tab = manual adjust + stock-out reasons (+ tagged stock-in via control_source)
export const ADJUSTMENT_LEDGER_TYPES = [
  MOVEMENT_TYPES.ADJUSTMENT,
  MOVEMENT_TYPES.DAMAGED,
  MOVEMENT_TYPES.EXPIRED,
  MOVEMENT_TYPES.OTHER,
]

export const PURCHASE_ORDER_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PARTIALLY_RECEIVED: 'partially_received',
  RECEIVED: 'received',
  CANCELLED: 'cancelled',
}

// Append-only purchase_order_events.event_type values (migration 048)
export const PURCHASE_ORDER_EVENT_TYPES = {
  CREATED: 'created',
  EDITED_BY_BM: 'edited_by_bm',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  RECEIVAL_RECORDED: 'receival_recorded',
  COMPLETED: 'completed',
}

// TL §10.3 — PDF / Send / Excel allowed once order left Pending review
export const PURCHASE_ORDER_INVOICE_DOWNLOAD_STATUSES = [
  PURCHASE_ORDER_STATUS.APPROVED,
  PURCHASE_ORDER_STATUS.PARTIALLY_RECEIVED,
  PURCHASE_ORDER_STATUS.RECEIVED,
]

export const STOCK_REQUEST_KIND = {
  ALERT: 'alert',
  REQUEST: 'request',
}

export const ATTENDANCE_STATUS = {
  PRESENT: 'present',
  ABSENT: 'absent',
  LATE: 'late',
  HOLIDAY: 'holiday',
  LEAVE: 'leave',
}

export const POINT_SYSTEMS = {
  PUNCTUALITY: 'punctuality',
  SALES_TARGET: 'sales_target',
  CUSTOMER_SERVICE: 'customer_service',
}

export const STAFF_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  OPEN: 'active',
  BLOCKED: 'inactive',
}

export const BRANCH_STATUS = {
  OPEN: 'open',
  BLOCKED: 'blocked',
}

export const SALE_STATUS = {
  COMPLETED: 'completed',
  REFUNDED: 'refunded',
  PARTIAL_REFUND: 'partial_refund',
  VOID: 'void',
}

//POS invoice type (Sale / Return / Exchange) — stored on sales.invoice_type
export const INVOICE_TYPES = {
  SALE: 'sale',
  RETURN: 'return',
  EXCHANGE: 'exchange',
}

export const PERMISSIONS = {
  'staff:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'staff:write': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'designations:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'designations:write': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'attendance:write': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'performance:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'branch-dashboard:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'activity-logs:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'resources:read': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN, ROLES.INVENTORY_MANAGER],
  'resources:write': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'dashboard:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'items:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'items:write': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'stock:write': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN],
  'stock:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'staff:lookup': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'stock-requests:write': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  // Supplier RBAC (CEO): IM + BM create/edit · BM block/delete · IM cannot block/delete
  'suppliers:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'suppliers:write': [ROLES.INVENTORY_MANAGER, ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  // Block / Unblock — BM + B2B only (IM excluded)
  'suppliers:moderate': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  // Hard delete — BM + B2B (IM excluded; dependency check still blocks if used on orders)
  'suppliers:delete': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'orders:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN, ROLES.BRANCH_MANAGER],
  'orders:generate': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN],
  // BM reviews Demand Requests (edit / approve / reject); B2B retained for oversight
  'orders:approve': [ROLES.BRANCH_MANAGER, ROLES.B2B_ADMIN],
  'reports:read': [ROLES.INVENTORY_MANAGER, ROLES.B2B_ADMIN],
  'sync:push': [
    ROLES.CASHIER,
    ROLES.BRANCH_MANAGER,
    ROLES.BRANCH_ADMIN,
    ROLES.INVENTORY_MANAGER,
    ROLES.B2B_ADMIN,
  ],
  'sync:pull': [
    ROLES.CASHIER,
    ROLES.BRANCH_MANAGER,
    ROLES.BRANCH_ADMIN,
    ROLES.INVENTORY_MANAGER,
    ROLES.B2B_ADMIN,
  ],
  'admin:dashboard': [ROLES.B2B_ADMIN],
  'admin:branches': [ROLES.B2B_ADMIN],
  'admin:company': [ROLES.B2B_ADMIN],
  'admin:policies': [ROLES.B2B_ADMIN],
  // Admin Logs Module — company-wide audit (read + export only)
  'admin-logs:read': [ROLES.B2B_ADMIN],
}

export function hasPermission(role, permission) {
  return Boolean(PERMISSIONS[permission]?.includes(role))
}
