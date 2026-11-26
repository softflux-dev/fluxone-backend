// In-memory SSE hub: pushes "sync required" to connected branch POS apps.
// Single Node process (VPS). Multiple instances would need a shared bus (e.g. Redis pub/sub).

// Seconds the cashier gets to finish the current sale before a forced sync (system-level setting).
export const SYNC_WINDOW_SECONDS = Number(process.env.SYNC_WINDOW_SECONDS || 300)

const clients = new Set() // { res, tenantId, branchId }

export function addSyncClient(req, res, { tenantId, branchId }) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  res.write(`event: ready\ndata: ${JSON.stringify({ windowSeconds: SYNC_WINDOW_SECONDS })}\n\n`)

  const client = { res, tenantId, branchId: branchId || null }
  clients.add(client)
  // comment line keeps proxies from closing an idle stream
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => {
    clearInterval(ping)
    clients.delete(client)
  })
}

// branchId null -> every branch of the tenant.
export function broadcastSyncRequired(tenantId, branchId, reason) {
  const payload = JSON.stringify({
    reason,
    windowSeconds: SYNC_WINDOW_SECONDS,
    at: new Date().toISOString(),
  })
  for (const c of clients) {
    if (c.tenantId !== tenantId) continue
    if (branchId && c.branchId && c.branchId !== branchId) continue
    c.res.write(`event: sync-required\ndata: ${payload}\n\n`)
  }
}
