// posSlipPolicies.contract.js — POS receipt slip/policy contract (bootstrap + delta).
// Purpose: field names + helpers so POS prints enabled Admin policies on invoices.
// Prefer company.slipPolicies[]; fallback returnInstructions on older payloads.
// Read next: sync.mapper.js (slipPolicies), docs/SYNC_FLOW.md § contracts.

/**
 * FluxOne-POS slip / invoice policy contract (bootstrap + delta)
 *
 * Cloud already syncs Admin "Enabled" policies here. When working in FluxOne-POS,
 * consume these fields on receipt print after a sale — do not re-fetch Admin APIs.
 *
 * Snapshot paths (after mapSnapshotForPos):
 *   - data.policies[]              → enabled slip policies only
 *   - data.company.slipPolicies[]  → same list (preferred structured source)
 *   - data.company.returnInstructions → "Name: detail" blocks joined by \n\n (legacy printers)
 *   - data.company.warningMessage     → policy names joined by " · " (short footer)
 *
 * Each policy item shape:
 *   { id, name, detail, category, printOnSlip: true }
 *
 * POS print rules:
 *   1. On bootstrap/delta, persist company.slipPolicies (or policies) locally.
 *   2. When printing a sale slip/invoice, append every slipPolicies entry
 *      (name + detail) in the footer / terms section.
 *   3. If slipPolicies is empty, print nothing for policies.
 *   4. Prefer slipPolicies[]; fall back to returnInstructions if the list is missing
 *      on older cloud builds.
 *   5. Disabled (Enable=Off) policies are never included by cloud — no client filter needed.
 */

export const POS_SLIP_POLICY_FIELDS = Object.freeze({
  list: 'company.slipPolicies',
  listAlias: 'policies',
  flatText: 'company.returnInstructions',
  shortNames: 'company.warningMessage',
})

// Resolve policies for a POS receipt printer (use after bootstrap/delta apply).
export function resolveSlipPoliciesForPrint(snapshotOrCompany = {}) {
  const company = snapshotOrCompany.company || snapshotOrCompany
  const structured =
    (Array.isArray(company.slipPolicies) && company.slipPolicies) ||
    (Array.isArray(snapshotOrCompany.policies) && snapshotOrCompany.policies) ||
    []

  if (structured.length > 0) {
    return structured.map((p) => ({
      id: p.id || null,
      name: String(p.name || '').trim(),
      detail: String(p.detail || '').trim(),
    }))
  }

  // Legacy flat text fallback
  const flat = company.returnInstructions
  if (flat && String(flat).trim()) {
    return [{ id: null, name: 'Policy', detail: String(flat).trim() }]
  }

  return []
}

// Footer lines ready to send to a thermal / PDF printer.
export function formatSlipPolicyPrintLines(policies = []) {
  return policies
    .filter((p) => p.name || p.detail)
    .map((p) => (p.name && p.detail ? `${p.name}: ${p.detail}` : p.name || p.detail))
}
