import * as fc from 'fast-check';
import { checkAmount, type AmountCheckField } from './amount-check';

const NUM_RUNS = 100;

const amountArbitrary = fc.integer({ min: 0, max: 2_000_000_000 });
const currencyArbitrary = fc.oneof(
  fc.constantFrom('COP', 'USD', 'cop', ''),
  fc.stringMatching(/^[A-Za-z]{0,4}$/),
);
const referenceArbitrary = fc.oneof(
  fc.stringMatching(/^ORD-[0-9A-Z]{8}$/),
  fc.stringMatching(/^[ -~]{0,16}$/),
);

// Feature: payments-api, Property 46: Amount_Check gates finalization, overriding even an APPROVED report
describe('Feature: payments-api, Property 46: Amount_Check gates finalization, overriding even an APPROVED report (checkAmount)', () => {
  it('matches if and only if amount, currency and reference are all equal, over unrelated triples', () => {
    fc.assert(
      fc.property(
        fc.tuple(amountArbitrary, currencyArbitrary, referenceArbitrary),
        fc.tuple(amountArbitrary, currencyArbitrary, referenceArbitrary),
        ([reportedAmount, reportedCurrency, reportedReference], [total, currency, reference]) => {
          const result = checkAmount(
            {
              amountInCents: reportedAmount,
              currency: reportedCurrency,
              reference: reportedReference,
            },
            { totalInCents: total, currency, reference },
          );

          const differing: AmountCheckField[] = [];
          if (reportedAmount !== total) differing.push('amountInCents');
          if (reportedCurrency !== currency) differing.push('currency');
          if (reportedReference !== reference) differing.push('reference');
          expect(result).toEqual(
            differing.length === 0 ? { kind: 'match' } : { kind: 'mismatch', fields: differing },
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('lists exactly the fields that were altered, starting from a report that matches', () => {
    fc.assert(
      fc.property(
        amountArbitrary,
        currencyArbitrary,
        referenceArbitrary,
        fc.record({
          amount: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
          currency: fc.option(fc.stringMatching(/^[A-Za-z]{1,3}$/), { nil: undefined }),
          reference: fc.option(fc.stringMatching(/^[A-Za-z0-9-]{1,6}$/), { nil: undefined }),
        }),
        (total, currency, reference, change) => {
          // A suffix or an offset always produces a value different from the stored one.
          const reported = {
            amountInCents: total + (change.amount ?? 0),
            currency: change.currency === undefined ? currency : `${currency}${change.currency}`,
            reference:
              change.reference === undefined ? reference : `${reference}${change.reference}`,
          };
          const expected: AmountCheckField[] = [];
          if (change.amount !== undefined) expected.push('amountInCents');
          if (change.currency !== undefined) expected.push('currency');
          if (change.reference !== undefined) expected.push('reference');

          expect(checkAmount(reported, { totalInCents: total, currency, reference })).toEqual(
            expected.length === 0 ? { kind: 'match' } : { kind: 'mismatch', fields: expected },
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
