import { canTransitionDelivery, DELIVERY_STATUSES, type DeliveryStatus } from './delivery-status';

describe('DeliveryStatus', () => {
  it('lists the four statuses', () => {
    expect(DELIVERY_STATUSES).toEqual(['PENDING', 'ASSIGNED', 'BACKORDER', 'CANCELLED']);
  });

  it.each(['ASSIGNED', 'BACKORDER', 'CANCELLED'] as const)('allows PENDING to %s', (to) => {
    expect(canTransitionDelivery('PENDING', to)).toBe(true);
  });

  it('rejects a transition back to PENDING', () => {
    expect(canTransitionDelivery('PENDING', 'PENDING')).toBe(false);
  });

  it.each(['ASSIGNED', 'BACKORDER', 'CANCELLED'] as const)('rejects leaving %s', (from) => {
    for (const to of DELIVERY_STATUSES) {
      expect(canTransitionDelivery(from, to)).toBe(false);
    }
  });

  it('allows exactly the PENDING-to-target moves', () => {
    const allowed: Array<[DeliveryStatus, DeliveryStatus]> = [];
    for (const from of DELIVERY_STATUSES) {
      for (const to of DELIVERY_STATUSES) {
        if (canTransitionDelivery(from, to)) allowed.push([from, to]);
      }
    }
    expect(allowed).toHaveLength(3);
    expect(allowed.every(([from]) => from === 'PENDING')).toBe(true);
  });
});
