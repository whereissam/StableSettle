/** The six on-chain order states, indexed to match the Solidity enum. */
export const ORDER_STATES = [
  'Created',
  'Funded',
  'Delivered',
  'Released',
  'Disputed',
  'Resolved',
] as const

export type OrderState = (typeof ORDER_STATES)[number]

export function stateName(index: number): OrderState {
  return ORDER_STATES[index] ?? 'Created'
}

/** Contract events, in the order the audit log presents them. */
export const AUDIT_EVENTS = [
  'OrderCreated',
  'OrderFunded',
  'Delivered',
  'ActualDutiesReported',
  'AnomalyCleared',
  'Released',
  'DisputeRaised',
  'DisputeResolved',
] as const

export type AuditEventName = (typeof AUDIT_EVENTS)[number]

/** States in which the customer's funds are still sitting in the escrow. */
export const HELD_STATES: OrderState[] = ['Funded', 'Delivered', 'Disputed']
