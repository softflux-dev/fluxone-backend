import {
  createNotificationsForUsers,
  listTenantAdminUserIds,
  listBranchUserIds,
  listBranchManagerIdsForBranch,
  listInventoryManagerIdsForBranch,
  createNotification,
} from './notifications.model.js'

// BM submitted personal leave → notify all tenant admins
export async function notifyAdminsOfLeaveRequest(tenantId, leave, { managerName, branchName }) {
  const adminIds = await listTenantAdminUserIds(tenantId)
  if (!adminIds.length) return []

  const name = managerName || 'Branch Manager'
  const branch = branchName || 'their branch'
  const dates = formatRange(leave.startDate, leave.endDate)

  // Short header + full detail body (bell / inbox)
  const title = 'New Leave Request From Employee'
  const body = `New leave request submitted by ${name} of branch (${branch}) for (${dates}) and awaiting your approval.`

  return createNotificationsForUsers(tenantId, adminIds, {
    type: 'leave_request',
    title,
    body,
    linkPath: `/admin/leaves?highlight=${leave.id}`,
    entityType: 'leave',
    entityId: leave.id,
    meta: {
      leaveId: leave.id,
      managerName: name,
      branchName: branch,
      startDate: leave.startDate,
      endDate: leave.endDate,
      reason: leave.reason || null,
    },
  })
}

// Admin decided BM leave → notify the requesting BM (in-app)
export async function notifyBmOfLeaveDecision(tenantId, leave, { status, decisionReason, decidedByName }) {
  if (!leave?.requestedBy) return null

  const approved = status === 'approved'
  const title = approved
    ? 'Your leave request was approved.'
    : 'Your leave request was rejected.'
  const reasonNote = decisionReason ? ` Reason: ${decisionReason}` : ''

  return createNotification(tenantId, {
    recipientUserId: leave.requestedBy,
    type: 'leave_decision',
    title,
    body: `Status: ${status}.${reasonNote}`,
    linkPath: `/branch/leaves?tab=mine&highlight=${leave.id}`,
    entityType: 'leave',
    entityId: leave.id,
    meta: {
      leaveId: leave.id,
      status,
      decisionReason: decisionReason || null,
      decidedByName: decidedByName || null,
      startDate: leave.startDate,
      endDate: leave.endDate,
    },
  })
}

// BM replenishment / low-stock request → notify IMs on the SAME branch only
export async function notifyInventoryManagersOfStockRequest(
  tenantId,
  request,
  { managerName, branchName } = {},
) {
  const branchId = request?.branchId || null
  if (!branchId) {
    console.warn('[notifications] stock_request missing branchId — skipping IM notify')
    return []
  }

  const imIds = await listInventoryManagerIdsForBranch(tenantId, branchId)
  if (!imIds.length) return []

  const name = managerName || 'Branch Manager'
  const branch = branchName || request.branchName || 'a branch'
  const product = request.productName || 'a product'
  const qty = Number(request.remainingQuantity)
  const qtyLabel = Number.isFinite(qty) ? String(Math.floor(qty)) : '—'
  const isAlert = request.kind === 'alert'
  const title = isAlert
    ? 'Low Stock Alert From Branch'
    : 'New Replenishment Request'
  const body = isAlert
    ? `${name} flagged low stock for ${product}. Required quantity: ${qtyLabel}. Open Inventory Overview → Stock Alerts, then add stock via Control → Stock In or Generate Order.`
    : `${name} requested ${qtyLabel} unit(s) of ${product}. Open Inventory Overview → Stock Alerts, then add stock via Control → Stock In or Generate Order.`

  // Deep-link: IM Dashboard → Stock Alerts & Requests (highlight row)
  return createNotificationsForUsers(tenantId, imIds, {
    type: 'stock_request',
    title,
    body,
    linkPath: `/inventory?focus=alerts&requestId=${request.id}`,
    entityType: 'stock_request',
    entityId: request.id,
    meta: {
      stockRequestId: request.id,
      productId: request.productId || null,
      productName: product,
      branchId,
      branchName: branch,
      managerName: name,
      kind: request.kind,
      requiredQuantity: Number.isFinite(qty) ? Math.floor(qty) : null,
    },
  })
}

function formatRange(start, end) {
  const opts = { weekday: 'short', month: 'short', day: 'numeric' }
  const a = start ? new Date(start) : null
  const b = end ? new Date(end) : null
  if (!a || Number.isNaN(a.getTime()) || !b || Number.isNaN(b.getTime())) return '—'
  const left = a.toLocaleDateString('en-US', opts)
  const right = b.toLocaleDateString('en-US', opts)
  return left === right ? left : `${left} – ${right}`
}

// BM created a holiday → notify all tenant admins
export async function notifyAdminsOfHoliday(
  tenantId,
  holiday,
  { managerName, branchName } = {},
) {
  const adminIds = await listTenantAdminUserIds(tenantId)
  if (!adminIds.length) return []

  const name = holiday?.name || 'Holiday'
  const branch = branchName || 'a branch'
  const manager = managerName || 'Branch Manager'
  const dates = formatRange(holiday.startDate, holiday.endDate || holiday.startDate)

  return createNotificationsForUsers(tenantId, adminIds, {
    type: 'holiday_created',
    title: 'New Holiday Scheduled',
    body: `Branch: ${branch}. Holiday: ${name}. Date(s): ${dates}. Created by: ${manager}.`,
    linkPath: '/admin/notifications',
    entityType: 'holiday',
    entityId: holiday.id,
    meta: {
      holidayId: holiday.id,
      holidayName: name,
      branchName: branch,
      managerName: manager,
      startDate: holiday.startDate,
      endDate: holiday.endDate || holiday.startDate,
    },
  })
}

// BM created a holiday → notify branch staff / cashiers (exclude creator + admins)
export async function notifyBranchUsersOfHoliday(
  tenantId,
  holiday,
  { managerName, branchName, excludeUserId } = {},
) {
  const branchId = holiday?.branchId || null
  if (!branchId) return []

  const recipientIds = await listBranchUserIds(tenantId, branchId, {
    excludeUserIds: excludeUserId ? [excludeUserId] : [],
  })
  if (!recipientIds.length) return []

  const name = holiday?.name || 'Holiday'
  const branch = branchName || 'your branch'
  const manager = managerName || 'Branch Manager'
  const dates = formatRange(holiday.startDate, holiday.endDate || holiday.startDate)

  return createNotificationsForUsers(tenantId, recipientIds, {
    type: 'holiday_created',
    title: 'Holiday Announced',
    body: `${name} at ${branch} on ${dates}. Created by ${manager}.`,
    linkPath: '/branch/holidays',
    entityType: 'holiday',
    entityId: holiday.id,
    meta: {
      holidayId: holiday.id,
      holidayName: name,
      branchName: branch,
      managerName: manager,
      startDate: holiday.startDate,
      endDate: holiday.endDate || holiday.startDate,
    },
  })
}

// IM submitted order request → notify Branch Managers (Demand Requests)
export async function notifyBranchManagersOfOrderRequest(
  tenantId,
  order,
  { inventoryManagerName, itemCount, companyCount } = {},
) {
  const branchId = order?.branchId || null
  const bmIds = await listBranchManagerIdsForBranch(tenantId, branchId)
  if (!bmIds.length) return []

  const imName = inventoryManagerName || 'Inventory Manager'
  const orderRef = order?.orderNumber || order?.id || '—'
  const items = Number(itemCount) || 0
  const companies = Number(companyCount) || 0

  return createNotificationsForUsers(tenantId, bmIds, {
    type: 'order_request_submitted',
    title: 'New Order Request',
    body: `${imName} has submitted a new order request (Order #${orderRef}) containing ${items} items from ${companies} supplier(s). Please review in Inventory Monitoring → Demand Requests.`,
    linkPath: `/branch/inventory?tab=demand&highlight=${order.id}`,
    entityType: 'purchase_order',
    entityId: order.id,
    meta: {
      purchaseOrderId: order.id,
      orderNumber: orderRef,
      inventoryManagerName: imName,
      itemCount: items,
      companyCount: companies,
      branchId,
      branchName: order?.branchName || null,
    },
  })
}

// BM approved order → notify submitting Inventory Manager
export async function notifyInventoryManagerOfOrderApproved(
  tenantId,
  order,
  { branchManagerName } = {},
) {
  if (!order?.createdBy) return null
  const bmName = branchManagerName || 'Branch Manager'
  const orderRef = order?.orderNumber || order?.id || '—'

  return createNotification(tenantId, {
    recipientUserId: order.createdBy,
    type: 'order_request_approved',
    title: 'Order Request Approved',
    body: `Your order request (Order #${orderRef}) has been approved by ${bmName}. You can now proceed with receiving the items.`,
    linkPath: `/inventory/orders/${order.id}`,
    entityType: 'purchase_order',
    entityId: order.id,
    meta: {
      purchaseOrderId: order.id,
      orderNumber: orderRef,
      branchManagerName: bmName,
      status: 'approved',
    },
  })
}

// BM rejected order → notify submitting Inventory Manager
export async function notifyInventoryManagerOfOrderRejected(
  tenantId,
  order,
  { branchManagerName, rejectionNotes } = {},
) {
  if (!order?.createdBy) return null
  const bmName = branchManagerName || 'Branch Manager'
  const orderRef = order?.orderNumber || order?.id || '—'
  const notes = rejectionNotes ? ` Notes: ${rejectionNotes}` : ''

  return createNotification(tenantId, {
    recipientUserId: order.createdBy,
    type: 'order_request_rejected',
    title: 'Order Request Rejected',
    body: `Your order request (Order #${orderRef}) has been rejected by ${bmName}. Please create a new order request if needed.${notes}`,
    linkPath: `/inventory/orders/${order.id}`,
    entityType: 'purchase_order',
    entityId: order.id,
    meta: {
      purchaseOrderId: order.id,
      orderNumber: orderRef,
      branchManagerName: bmName,
      rejectionNotes: rejectionNotes || null,
      status: 'rejected',
    },
  })
}

// IM recorded a receival round → notify Branch Managers (TL §6 / §7)
export async function notifyBranchManagersOfItemsReceived(
  tenantId,
  order,
  { inventoryManagerName, lineCount, totalUnits, completed = false } = {},
) {
  const branchId = order?.branchId || null
  const bmIds = await listBranchManagerIdsForBranch(tenantId, branchId)
  if (!bmIds.length) return []

  const imName = inventoryManagerName || 'Inventory Manager'
  const orderRef = order?.orderNumber || order?.id || '—'
  const lines = Number(lineCount) || 0
  const units = Number(totalUnits) || 0

  if (completed) {
    return createNotificationsForUsers(tenantId, bmIds, {
      type: 'order_receival_completed',
      title: 'Order Receival Completed',
      body: `${imName} marked Order #${orderRef} as fully received. Stock is in the ledger.`,
      linkPath: `/branch/inventory?tab=demand&highlight=${order.id}`,
      entityType: 'purchase_order',
      entityId: order.id,
      meta: {
        purchaseOrderId: order.id,
        orderNumber: orderRef,
        inventoryManagerName: imName,
        status: 'received',
        branchId,
      },
    })
  }

  return createNotificationsForUsers(tenantId, bmIds, {
    type: 'order_items_received',
    title: 'Order Items Received',
    body: `${imName} recorded a receival on Order #${orderRef}: ${lines} line(s), ${units} unit(s) stocked in.`,
    linkPath: `/branch/inventory?tab=demand&highlight=${order.id}`,
    entityType: 'purchase_order',
    entityId: order.id,
    meta: {
      purchaseOrderId: order.id,
      orderNumber: orderRef,
      inventoryManagerName: imName,
      lineCount: lines,
      totalUnits: units,
      status: 'partially_received',
      branchId,
    },
  })
}

// TL §10.3 — supplier invoice emailed → notify Branch Managers (in-app)
export async function notifyBranchManagersOfInvoiceEmailed(
  tenantId,
  order,
  { invoiceNumber, supplierName, sentTo, stubbed = false, actorName } = {},
) {
  const branchId = order?.branchId || null
  const bmIds = await listBranchManagerIdsForBranch(tenantId, branchId)
  if (!bmIds.length) return []

  const orderRef = order?.orderNumber || order?.id || '—'
  const inv = invoiceNumber || '—'
  const who = actorName || 'A team member'
  const title = stubbed ? 'Invoice email stubbed (SMTP off)' : 'Invoice emailed to supplier'
  const body = stubbed
    ? `${who} prepared invoice ${inv} for order #${orderRef} (${supplierName || 'supplier'}) to ${sentTo || '—'}, but SMTP is not configured.`
    : `${who} emailed invoice ${inv} for order #${orderRef} to ${sentTo || 'the supplier'} (${supplierName || 'supplier'}).`

  return createNotificationsForUsers(tenantId, bmIds, {
    type: 'order_invoice_emailed',
    title,
    body,
    linkPath: `/branch/inventory?tab=demand&highlight=${order.id}`,
    entityType: 'purchase_order',
    entityId: order.id,
    meta: {
      purchaseOrderId: order.id,
      orderNumber: orderRef,
      invoiceNumber: inv,
      supplierName: supplierName || null,
      sentTo: sentTo || null,
      stubbed: Boolean(stubbed),
      actorName: who,
    },
  })
}

// IM added custom variant → notify BMs on the SAME branch only
export async function notifyBranchManagersOfCustomVariants(
  tenantId,
  { productId, productName, creatorName, additions, branchId = null } = {},
) {
  const rows = Array.isArray(additions) ? additions : []
  const actionable = rows.filter(
    (row) =>
      row?.typeCreated ||
      (Array.isArray(row?.values) && row.values.some((v) => v?.created)),
  )
  if (!actionable.length) return []

  const bmIds = await listBranchManagerIdsForBranch(tenantId, branchId)
  if (!bmIds.length) return []

  const product = productName || 'a product'
  const creator = creatorName || 'Inventory Manager'
  const summary = actionable
    .map((row) => {
      const newValues = (row.values || [])
        .filter((v) => v?.created)
        .map((v) => v.name)
      const typeLabel = row.typeCreated ? `${row.typeName} (new type)` : row.typeName
      if (!newValues.length && row.typeCreated) return typeLabel
      if (!newValues.length) return null
      return `${typeLabel}: ${newValues.join(', ')}`
    })
    .filter(Boolean)
    .join('; ')

  const title = 'New Custom Variant Added to Catalog'
  const body = `${creator} added custom variant data on “${product}”. ${summary}. Review in Resources.`

  return createNotificationsForUsers(tenantId, bmIds, {
    type: 'custom_variant_catalog',
    title,
    body,
    linkPath: '/branch/resources',
    entityType: 'product',
    entityId: productId || null,
    meta: {
      productId: productId || null,
      productName: product,
      creatorName: creator,
      branchId: branchId || null,
      additions: actionable,
    },
  })
}
