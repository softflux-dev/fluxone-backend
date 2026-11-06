import { getInvoiceById, getInvoicesSummary, listInvoices } from './invoices.model.js'
import { fail, success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'

export async function invoicesList(req, res) {
  const result = await listInvoices(req.tenantId, req.validated.query)
  return success(res, paginatedResult(result.items, result))
}

export async function invoiceDetail(req, res) {
  const row = await getInvoiceById(req.tenantId, req.validated.params.id)
  if (!row) return fail(res, 'Invoice not found', 404)
  return success(res, row)
}

export async function invoicesSummary(req, res) {
  const summary = await getInvoicesSummary(req.tenantId)
  return success(res, summary)
}
