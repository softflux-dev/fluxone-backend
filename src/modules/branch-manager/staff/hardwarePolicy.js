import { ROLES } from '../../../config/constants.js'

// Role → how hardware may be assigned in this branch.
// IM: device locked exclusively (no other role/shift may use it).
// Cashier: shift-based sharing (1 device, many cashiers if times don't overlap).
// Phase-2 roles: optional simple assign (no exclusive lock).
export const HARDWARE_MODES = {
  EXCLUSIVE: 'exclusive',
  SHARED: 'shared',
  OPTIONAL: 'optional',
}

export function hardwareModeForRole(role) {
  if (role === ROLES.INVENTORY_MANAGER) return HARDWARE_MODES.EXCLUSIVE
  if (role === ROLES.CASHIER) return HARDWARE_MODES.SHARED
  return HARDWARE_MODES.OPTIONAL
}

// True when this role participates in schedule-gated hardware UX.
export function roleUsesHardwareScheduleGate(role) {
  const mode = hardwareModeForRole(role)
  return mode === HARDWARE_MODES.EXCLUSIVE || mode === HARDWARE_MODES.SHARED
}

// Assigning hardware requires a complete shift window for IM + Cashier.
export function roleRequiresShiftForHardware(role) {
  return roleUsesHardwareScheduleGate(role)
}

// Exclusive holders fully lock a device (IM). Shared holders only block overlapping slots.
export function isExclusiveHardwareMode(mode) {
  return mode === HARDWARE_MODES.EXCLUSIVE
}
