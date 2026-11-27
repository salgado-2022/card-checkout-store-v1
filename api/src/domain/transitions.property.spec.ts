import * as fc from 'fast-check';
import { canTransitionDelivery, DELIVERY_STATUSES } from './delivery-status';
import {
  canTransitionTransaction,
  FINAL_STATUSES,
  TRANSACTION_STATUSES,
} from './transaction-status';

// Feature: payments-api, Property 32: The transition functions only allow the documented moves
describe('Feature: payments-api, Property 32: The transition functions only allow the documented moves', () => {
  it('allows a transaction move only from PENDING to a final status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TRANSACTION_STATUSES),
        fc.constantFrom(...TRANSACTION_STATUSES),
        (from, to) => {
          const documented =
            from === 'PENDING' && (FINAL_STATUSES as readonly string[]).includes(to);
          expect(canTransitionTransaction(from, to)).toBe(documented);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('checks every transaction pair exhaustively against the documented rule', () => {
    for (const from of TRANSACTION_STATUSES) {
      for (const to of TRANSACTION_STATUSES) {
        const documented = from === 'PENDING' && (FINAL_STATUSES as readonly string[]).includes(to);
        expect(canTransitionTransaction(from, to)).toBe(documented);
      }
    }
  });

  it('allows a delivery move only from PENDING to ASSIGNED, BACKORDER or CANCELLED', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DELIVERY_STATUSES),
        fc.constantFrom(...DELIVERY_STATUSES),
        (from, to) => {
          const documented =
            from === 'PENDING' && (to === 'ASSIGNED' || to === 'BACKORDER' || to === 'CANCELLED');
          expect(canTransitionDelivery(from, to)).toBe(documented);
        },
      ),
      { numRuns: 100 },
    );
  });
});
