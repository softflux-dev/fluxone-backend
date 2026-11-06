import {
  approvePurchaseOrder,
  buildPurchaseOrderPrint,
  cancelPurchaseOrder,
  completePurchaseOrderReceival,
  generatePurchaseOrder,
  getPurchaseOrderById,
  listPurchaseOrders,
  priceHistory,
  recordPurchaseOrderReceival,
  rejectPurchaseOrder,
  sendPurchaseOrderSms,
  updatePendingPurchaseOrder,
} from './purchase_order.model.js'
import {
  canDownloadOrderInvoices,
  getInvoiceById,
  listBranchManagerContactsForOrder,
  listInvoicesForOrder,
  markInvoiceSent,
} from './purchase_order_invoice.model.js'
import { resolveInventoryCreateScope, resolveInventoryScope } from '../shared.access.js'
import { fail, failFromError, success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import {
  notifyBranchManagersOfInvoiceEmailed,
  notifyBranchManagersOfItemsReceived,
  notifyBranchManagersOfOrderRequest,
  notifyInventoryManagerOfOrderApproved,
  notifyInventoryManagerOfOrderRejected,
} from '../../notifications/notifications.service.js'
import {
  sendPurchaseOrderInvoiceEmail,
  sendPurchaseOrderInvoiceSentBmEmail,
} from '../../../mail/mail.service.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

export async function list(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const result = await listPurchaseOrders(tenantId, { ...req.validated.query, branchId })
    return success(res, paginatedResult(result.items, result))
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function generate(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryCreateScope(req)
    const order = await generatePurchaseOrder(tenantId, {
      ...req.validated.body,
      branchId,
      createdBy: req.user.id,
    })

    // Notify BM — Demand Requests (TL §7.2)
    try {
      await notifyBranchManagersOfOrderRequest(tenantId, order, {
        inventoryManagerName: order.createdByName || 'Inventory Manager',
        itemCount: order.itemsNumber,
        companyCount: order.companiesNumber,
      })
    } catch (notifyErr) {
      console.error('Order submit notification failed:', notifyErr.message)
    }

    let sms = null
    if (req.validated.body.sendSms) {
      try {
        sms = await sendPurchaseOrderSms(tenantId, order.id, { branchId })
      } catch (err) {
        sms = { sent: false, error: err.message || 'Failed to send SMS' }
      }
    }

    return success(res, { ...order, sms }, 201)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function detail(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const order = await getPurchaseOrderById(tenantId, req.validated.params.id, { branchId })
    if (!order) return fail(res, 'Purchase order not found', 404)
    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function history(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const data = await priceHistory(tenantId, req.validated.params.id, { branchId })
    if (!data) return fail(res, 'Purchase order not found', 404)
    return success(res, data)
  } catch (err) {
    return failFromError(res, err)
  }
}

// BM edit while Pending
export async function updatePending(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const order = await updatePendingPurchaseOrder(
      tenantId,
      req.validated.params.id,
      req.validated.body,
      { branchId, actorId: req.user.id },
    )
    if (!order) return fail(res, 'Purchase order not found', 404)
    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function cancel(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const order = await cancelPurchaseOrder(tenantId, req.validated.params.id, {
      branchId,
      actorId: req.user.id,
    })
    if (!order) return fail(res, 'Purchase order not found', 404)
    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function approve(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const orderId = req.validated.params.id
    const order = await approvePurchaseOrder(tenantId, orderId, req.user.id, {
      branchId,
    })
    if (!order) return fail(res, 'Purchase order not found', 404)

    // Respond immediately — do not await invoice re-list or IM notify (UX latency).
    void notifyInventoryManagerOfOrderApproved(tenantId, order, {
      branchManagerName: order.approvedByName || 'Branch Manager',
    }).catch((notifyErr) => {
      console.error('Order approve notification failed:', notifyErr.message)
    })

    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}

// TL §10 — list invoices for an order (IM + BM via orders:read)
export async function listInvoices(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const data = await listInvoicesForOrder(tenantId, req.validated.params.id, { branchId })
    if (!data) return fail(res, 'Purchase order not found', 404)
    return success(res, data)
  } catch (err) {
    return failFromError(res, err)
  }
}

// TL §10 — invoice detail + locked line items (PDF/Excel/send consume this)
export async function invoiceDetail(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const orderId = req.validated.params.id
    const invoiceId = req.validated.params.invoiceId

    const order = await getPurchaseOrderById(tenantId, orderId, { branchId })
    if (!order) return fail(res, 'Purchase order not found', 404)

    const invoice = await getInvoiceById(tenantId, invoiceId, { branchId })
    if (!invoice || invoice.purchaseOrderId !== orderId) {
      return fail(res, 'Invoice not found for this order', 404)
    }

    return success(res, invoice)
  } catch (err) {
    return failFromError(res, err)
  }
}

// TL §10.3 — email invoice PDF to supplier; confirm to BM (in-app + email)
export async function sendInvoice(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const orderId = req.validated.params.id
    const invoiceId = req.validated.params.invoiceId
    const { pdfBase64, filename } = req.validated.body

    const order = await getPurchaseOrderById(tenantId, orderId, { branchId })
    if (!order) return fail(res, 'Purchase order not found', 404)
    if (!canDownloadOrderInvoices(order.status)) {
      return fail(res, 'Invoices can only be sent after the order is approved', 400)
    }

    const invoice = await getInvoiceById(tenantId, invoiceId, { branchId })
    if (!invoice || invoice.purchaseOrderId !== orderId) {
      return fail(res, 'Invoice not found for this order', 404)
    }

    const toEmail = String(invoice.supplier?.representativeEmail || '').trim()
    if (!toEmail) {
      return fail(res, 'Supplier representative email is missing', 422)
    }

    let pdfBuffer
    try {
      pdfBuffer = Buffer.from(pdfBase64, 'base64')
    } catch {
      return fail(res, 'Invalid PDF attachment', 422)
    }
    if (!pdfBuffer?.length) return fail(res, 'PDF attachment is empty', 422)

    const safeFilename =
      filename && String(filename).toLowerCase().endsWith('.pdf')
        ? String(filename)
        : `${invoice.invoiceNumber || 'invoice'}.pdf`

    const mailResult = await sendPurchaseOrderInvoiceEmail({
      toEmail,
      supplierName: invoice.supplier?.companyName,
      representativeName: invoice.supplier?.representativeName,
      invoiceNumber: invoice.invoiceNumber,
      orderNumber: invoice.orderNumber || order.orderNumber,
      branchName: invoice.branch?.name || order.branchName,
      companyName: 'FluxOne Inventory',
      pdfBuffer,
      filename: safeFilename,
    })

    // Persist send attempt even when SMTP stubbed (audit trail)
    const sentMeta = await markInvoiceSent(null, tenantId, invoiceId, {
      sentTo: toEmail,
      sentAt: new Date(),
    })

    await writeAdminActivity(tenantId, {
      branchId: order.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'orders_suppliers',
      action: 'invoice_send',
      entityType: 'purchase_order_invoice',
      entityId: invoiceId,
      actionText: `Sent invoice ${invoice.invoiceNumber} for order ${order.orderNumber || orderId} to ${toEmail}.`,
      affectedItem: invoice.invoiceNumber,
    })

    const actorName = req.user?.fullName || req.user?.name || 'Team member'
    try {
      await notifyBranchManagersOfInvoiceEmailed(tenantId, order, {
        invoiceNumber: invoice.invoiceNumber,
        supplierName: invoice.supplier?.companyName,
        sentTo: toEmail,
        stubbed: Boolean(mailResult.stubbed),
        actorName,
      })
    } catch (notifyErr) {
      console.error('Invoice emailed BM notification failed:', notifyErr.message)
    }

    // Email confirmation to BM(s) — non-blocking
    try {
      const managers = await listBranchManagerContactsForOrder(tenantId, order.branchId)
      for (const bm of managers) {
        if (!bm.email) continue
        await sendPurchaseOrderInvoiceSentBmEmail({
          toEmail: bm.email,
          recipientName: bm.fullName,
          invoiceNumber: invoice.invoiceNumber,
          orderNumber: invoice.orderNumber || order.orderNumber,
          supplierName: invoice.supplier?.companyName,
          sentTo: toEmail,
          stubbed: Boolean(mailResult.stubbed),
        })
      }
    } catch (bmMailErr) {
      console.error('Invoice emailed BM email failed:', bmMailErr.message)
    }

    return success(res, {
      invoiceId,
      invoiceNumber: invoice.invoiceNumber,
      sentTo: toEmail,
      sent: Boolean(mailResult.sent),
      stubbed: Boolean(mailResult.stubbed),
      error: mailResult.error || null,
      lastSentAt: sentMeta?.lastSentAt || null,
    })
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function reject(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const notes = req.validated.body.rejectionNotes || req.validated.body.notes || null
    const order = await rejectPurchaseOrder(tenantId, req.validated.params.id, req.user.id, {
      branchId,
      rejectionNotes: notes,
    })
    if (!order) return fail(res, 'Purchase order not found', 404)

    try {
      await notifyInventoryManagerOfOrderRejected(tenantId, order, {
        branchManagerName: order.rejectedByName || 'Branch Manager',
        rejectionNotes: notes,
      })
    } catch (notifyErr) {
      console.error('Order reject notification failed:', notifyErr.message)
    }

    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function print(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const data = await buildPurchaseOrderPrint(tenantId, req.validated.params.id, { branchId })
    if (!data) return fail(res, 'Purchase order not found', 404)

    if (req.query.format === 'json') {
      return success(res, data)
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.send(data.html)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function sendSmsToSupplier(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const result = await sendPurchaseOrderSms(tenantId, req.validated.params.id, { branchId })
    if (!result) return fail(res, 'Purchase order not found', 404)
    return success(res, result)
  } catch (err) {
    return failFromError(res, err)
  }
}

// IM — Record Receival (multi-round stock-in linked to Order ID)
export async function recordReceival(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const data = await recordPurchaseOrderReceival(
      tenantId,
      req.validated.params.id,
      req.validated.body,
      { branchId, actorId: req.user.id },
    )

    try {
      const order = data.order || data
      await notifyBranchManagersOfItemsReceived(tenantId, order, {
        inventoryManagerName: req.user?.name || req.user?.fullName || 'Inventory Manager',
        lineCount: data.lineCount,
        totalUnits: data.totalUnits,
        completed: Boolean(data.autoCompleted),
      })
    } catch (notifyErr) {
      console.error('Order receival notification failed:', notifyErr.message)
    }

    return success(res, data, 201)
  } catch (err) {
    return failFromError(res, err)
  }
}

// IM — Mark Complete after ≥1 receival round
export async function completeReceival(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const order = await completePurchaseOrderReceival(tenantId, req.validated.params.id, {
      branchId,
      actorId: req.user.id,
    })
    if (!order) return fail(res, 'Purchase order not found', 404)

    try {
      await notifyBranchManagersOfItemsReceived(tenantId, order, {
        inventoryManagerName: req.user?.name || req.user?.fullName || 'Inventory Manager',
        completed: true,
      })
    } catch (notifyErr) {
      console.error('Order complete notification failed:', notifyErr.message)
    }

    return success(res, order)
  } catch (err) {
    return failFromError(res, err)
  }
}
