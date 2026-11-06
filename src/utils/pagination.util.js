export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 8
export const MAX_PAGE_SIZE = 200

export function parsePagination(query = {}) {
  const page = Math.max(1, Number(query.page) || DEFAULT_PAGE)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.limit) || DEFAULT_PAGE_SIZE))
  const offset = (page - 1) * limit
  return { page, limit, offset }
}

export function buildPaginationMeta({ page, limit, total }) {
  const safeTotal = Number(total) || 0
  return {
    page,
    limit,
    total: safeTotal,
    pageCount: Math.max(1, Math.ceil(safeTotal / limit)),
  }
}

export function paginatedResult(items, { page, limit, total }) {
  return {
    items,
    pagination: buildPaginationMeta({ page, limit, total }),
  }
}
