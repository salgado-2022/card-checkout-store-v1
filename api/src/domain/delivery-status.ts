export const DELIVERY_STATUSES = ['PENDING', 'ASSIGNED', 'BACKORDER', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const TARGET_STATUSES: readonly DeliveryStatus[] = ['ASSIGNED', 'BACKORDER', 'CANCELLED'];

/** A Delivery moves only from PENDING to ASSIGNED, BACKORDER or CANCELLED (Requirement 10.7). */
export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return from === 'PENDING' && TARGET_STATUSES.includes(to);
}
