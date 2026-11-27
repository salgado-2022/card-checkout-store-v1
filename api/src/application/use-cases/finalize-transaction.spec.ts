import { okAsync } from 'neverthrow';
import type { Transaction } from '../../domain/entities';
import type { FinalStatus } from '../../domain/transaction-status';
import { FakeApplicationLogger } from '../../../test/support/fake-application-logger';
import { FakeClock } from '../../../test/support/fake-clock';
import { InMemoryDeliveryRepository } from '../../../test/support/in-memory-delivery-repository';
import { InMemoryProductRepository } from '../../../test/support/in-memory-product-repository';
import { InMemoryTransactionRepository } from '../../../test/support/in-memory-transaction-repository';
import type { RepositoryError } from '../errors';
import type {
  FinalizeInput,
  FinalizeOutcome,
  TransactionRepository,
} from '../ports/transaction-repository';
import { FinalizeTransaction, type FinalStatusOutcome } from './finalize-transaction';

const REFERENCE = 'ORD-01TESTREFERENCE0000000000';
const TOTAL = 25_100_000;
const MATCHING_REPORT = { amountInCents: TOTAL, currency: 'COP', reference: REFERENCE };

const reported = (status: FinalStatus, statusReason?: string): FinalStatusOutcome => ({
  source: 'provider',
  status,
  ...(statusReason === undefined ? {} : { statusReason }),
  report: MATCHING_REPORT,
});

interface Setup {
  readonly useCase: FinalizeTransaction;
  readonly transactions: InMemoryTransactionRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly products: InMemoryProductRepository;
  readonly logger: FakeApplicationLogger;
  readonly clock: FakeClock;
  readonly pending: Transaction;
}

async function setup(stock = 10): Promise<Setup> {
  const products = new InMemoryProductRepository([
    {
      id: 'prod-1',
      sku: 'SKU-1',
      name: 'Product',
      description: 'Description',
      imageUrl: 'https://cdn.example/p.webp',
      priceInCents: 12_000_000,
      currency: 'COP',
      stock,
    },
  ]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const logger = new FakeApplicationLogger();
  const clock = new FakeClock('2026-05-01T10:05:00.000Z');
  await deliveries.create({
    id: 'del-1',
    transactionId: 'txn-1',
    productId: 'prod-1',
    quantity: 2,
    recipientName: 'Ana Perez',
    phone: '3001234567',
    addressLine1: 'Calle 1 2-3',
    city: 'Bogota',
    department: 'Bogotá D.C.',
    createdAt: '2026-05-01T10:00:00.000Z',
  });
  const created = await transactions.create({
    id: 'txn-1',
    reference: REFERENCE,
    productId: 'prod-1',
    quantity: 2,
    customerId: 'cust-1',
    deliveryId: 'del-1',
    unitPriceInCents: 12_000_000,
    subtotalInCents: 24_000_000,
    baseFeeInCents: 300_000,
    deliveryFeeInCents: 800_000,
    totalInCents: TOTAL,
    currency: 'COP',
    installments: 1,
    cardBrand: 'VISA',
    cardLastFour: '4242',
    createdAt: '2026-05-01T10:00:00.000Z',
  });
  return {
    useCase: new FinalizeTransaction(transactions, logger, clock),
    transactions,
    deliveries,
    products,
    logger,
    clock,
    pending: created._unsafeUnwrap(),
  };
}

describe('FinalizeTransaction', () => {
  describe('already final transaction', () => {
    it.each<FinalStatus>(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR'])(
      'returns the stored %s transaction with no write and no Amount_Check',
      async (status) => {
        const s = await setup();
        const stored: Transaction = { ...s.pending, status };
        const outcome: FinalStatusOutcome = {
          source: 'provider',
          status: 'DECLINED',
          report: { amountInCents: 1, currency: 'USD', reference: 'other' },
        };
        const result = await s.useCase.execute(stored, outcome);
        expect(result._unsafeUnwrap()).toBe(stored);
        expect(s.transactions.appliedFinalizations).toBe(0);
        expect(s.logger.entries).toEqual([]);
        expect(s.products.stockOf('prod-1')).toBe(10);
      },
    );

    it('is idempotent: repeated calls change the stock only once', async () => {
      const s = await setup();
      const first = (await s.useCase.execute(s.pending, reported('APPROVED')))._unsafeUnwrap();
      await s.useCase.execute(first, reported('APPROVED'));
      await s.useCase.execute(s.pending, reported('APPROVED'));
      expect(s.products.stockOf('prod-1')).toBe(8);
      expect(s.transactions.appliedFinalizations).toBe(1);
    });
  });

  describe('provider outcomes', () => {
    it('APPROVED: assigns the delivery and decrements the stock', async () => {
      const s = await setup();
      const result = await s.useCase.execute(s.pending, reported('APPROVED'));
      expect(result._unsafeUnwrap()).toMatchObject({
        status: 'APPROVED',
        finalizedAt: '2026-05-01T10:05:00.000Z',
      });
      expect(s.deliveries.get('del-1')?.status).toBe('ASSIGNED');
      expect(s.products.stockOf('prod-1')).toBe(8);
      expect(s.logger.entries).toEqual([]);
    });

    it.each<FinalStatus>(['DECLINED', 'VOIDED', 'ERROR'])(
      '%s: stores the cleaned provider reason, cancels the delivery and keeps the stock',
      async (status) => {
        const s = await setup();
        const result = await s.useCase.execute(s.pending, reported(status, 'Fondos insuficientes'));
        expect(result._unsafeUnwrap()).toMatchObject({
          status,
          statusReason: 'Fondos insuficientes',
        });
        expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
        expect(s.logger.entries).toEqual([]);
      },
    );

    it('omits statusReason when the caller gives none', async () => {
      const s = await setup();
      const result = (await s.useCase.execute(s.pending, reported('DECLINED')))._unsafeUnwrap();
      expect(result).not.toHaveProperty('statusReason');
    });
  });

  describe('internal outcomes', () => {
    it('ERROR: stores the reason code, cancels the delivery and keeps the stock', async () => {
      const s = await setup();
      const result = await s.useCase.execute(s.pending, {
        source: 'internal',
        status: 'ERROR',
        statusReason: 'PROVIDER_UNREACHABLE',
      });
      expect(result._unsafeUnwrap()).toMatchObject({
        status: 'ERROR',
        statusReason: 'PROVIDER_UNREACHABLE',
      });
      expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
      expect(s.products.stockOf('prod-1')).toBe(10);
    });

    it('has nothing to compare: no Amount_Check and no alert', async () => {
      const s = await setup();
      await s.useCase.execute(s.pending, {
        source: 'internal',
        status: 'ERROR',
        statusReason: 'PROVIDER_UNREACHABLE',
      });
      expect(s.logger.entries).toEqual([]);
    });

    it('does not accept a report or a status other than ERROR (compile-time contract)', () => {
      const withReport: FinalStatusOutcome = {
        source: 'internal',
        status: 'ERROR',
        statusReason: 'X',
        // @ts-expect-error an internal outcome cannot carry a report
        report: MATCHING_REPORT,
      };
      // @ts-expect-error a provider outcome must carry the report
      const withoutReport: FinalStatusOutcome = { source: 'provider', status: 'APPROVED' };
      expect([withReport, withoutReport]).toHaveLength(2);
    });
  });

  describe('Amount_Check', () => {
    it.each<FinalStatus>(['APPROVED', 'DECLINED', 'VOIDED', 'ERROR'])(
      'a matching report finalizes with the reported %s',
      async (status) => {
        const s = await setup();
        const result = await s.useCase.execute(s.pending, reported(status, 'REPORTED'));
        expect(result._unsafeUnwrap()).toMatchObject({ status, statusReason: 'REPORTED' });
        expect(s.logger.entries).toEqual([]);
      },
    );

    const mismatches = [
      ['amountInCents', { ...MATCHING_REPORT, amountInCents: TOTAL - 1 }],
      ['currency', { ...MATCHING_REPORT, currency: 'USD' }],
      ['reference', { ...MATCHING_REPORT, reference: 'ORD-OTHER' }],
    ] as const;

    describe.each<FinalStatus>(['APPROVED', 'DECLINED'])('reported %s', (reportedStatus) => {
      it.each(mismatches)(
        'a different %s ends ERROR AMOUNT_MISMATCH, delivery CANCELLED, stock unchanged',
        async (field, report) => {
          const s = await setup();
          const result = await s.useCase.execute(s.pending, {
            source: 'provider',
            status: reportedStatus,
            statusReason: 'REPORTED',
            report,
          });
          expect(result._unsafeUnwrap()).toMatchObject({
            status: 'ERROR',
            statusReason: 'AMOUNT_MISMATCH',
          });
          expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
          expect(s.products.stockOf('prod-1')).toBe(10);
          expect(s.logger.at('alert')).toHaveLength(1);
          expect(s.logger.at('alert')[0]?.fields).toEqual({
            reference: REFERENCE,
            fields: field,
          });
        },
      );
    });

    it('lists every differing field in the alert and never logs the values', async () => {
      const s = await setup();
      await s.useCase.execute(s.pending, {
        source: 'provider',
        status: 'APPROVED',
        report: { amountInCents: 987_654_321, currency: 'USD', reference: 'ORD-SECRET-OTHER' },
      });
      const [entry] = s.logger.at('alert');
      expect(entry?.fields).toEqual({
        reference: REFERENCE,
        fields: 'amountInCents,currency,reference',
      });
      const logged = JSON.stringify(s.logger.entries);
      expect(logged).not.toContain('987654321');
      expect(logged).not.toContain('ORD-SECRET-OTHER');
      expect(logged).not.toContain('4242');
    });

    it('the check runs before any write: a failing repository still logs and no state changes', async () => {
      const s = await setup();
      s.transactions.failure = { kind: 'REPOSITORY_ERROR', reason: 'Boom' };
      const result = await s.useCase.execute(s.pending, {
        source: 'provider',
        status: 'APPROVED',
        report: { ...MATCHING_REPORT, amountInCents: 1 },
      });
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'REPOSITORY_ERROR', reason: 'Boom' });
      expect(s.logger.at('alert')).toHaveLength(1);
      expect(s.products.stockOf('prod-1')).toBe(10);
    });
  });

  describe('no stock left', () => {
    it('approves the transaction, sets the delivery to BACKORDER and alerts with reference and product', async () => {
      const s = await setup(1);
      const result = await s.useCase.execute(s.pending, reported('APPROVED'));
      expect(result._unsafeUnwrap().status).toBe('APPROVED');
      expect(s.deliveries.get('del-1')?.status).toBe('BACKORDER');
      expect(s.products.stockOf('prod-1')).toBe(1);
      expect(s.logger.at('alert')).toEqual([
        expect.objectContaining({ fields: { reference: REFERENCE, productId: 'prod-1' } }),
      ]);
    });

    it('declined outcomes never reach the stock check', async () => {
      const s = await setup(0);
      const result = await s.useCase.execute(s.pending, reported('DECLINED'));
      expect(result._unsafeUnwrap().status).toBe('DECLINED');
      expect(s.logger.entries).toEqual([]);
    });
  });

  describe('repository outcomes the in-memory fake cannot produce', () => {
    // Scripted repository: returns the given outcomes in order and records every finalize input.
    const scripted = (s: Setup, outcomes: FinalizeOutcome[]) => {
      const inputs: FinalizeInput[] = [];
      const repository = {
        finalize: (input: FinalizeInput) => {
          inputs.push(input);
          return okAsync<FinalizeOutcome, RepositoryError>(outcomes.shift() as FinalizeOutcome);
        },
      } as unknown as TransactionRepository;
      return { inputs, useCase: new FinalizeTransaction(repository, s.logger, s.clock) };
    };

    it('returns the stored state when another caller finalized it first', async () => {
      const s = await setup();
      const stored: Transaction = { ...s.pending, status: 'DECLINED' };
      const { useCase } = scripted(s, [{ kind: 'already_final', transaction: stored }]);
      const result = await useCase.execute(s.pending, reported('APPROVED'));
      expect(result._unsafeUnwrap()).toBe(stored);
      expect(s.logger.entries).toEqual([]);
    });

    it('retries once as BACKORDER and keeps the stored state, without alert, if it was finalized meanwhile', async () => {
      const s = await setup();
      const stored: Transaction = { ...s.pending, status: 'APPROVED' };
      const { useCase, inputs } = scripted(s, [
        { kind: 'stock_unavailable' },
        { kind: 'already_final', transaction: stored },
      ]);
      const result = await useCase.execute(s.pending, reported('APPROVED'));
      expect(result._unsafeUnwrap()).toBe(stored);
      expect(inputs.map((i) => i.deliveryStatus)).toEqual(['ASSIGNED', 'BACKORDER']);
      expect(inputs[1]).toMatchObject({ status: 'APPROVED', transactionId: 'txn-1' });
      expect(s.logger.at('alert')).toEqual([]);
    });

    it('fails with REPOSITORY_ERROR when the BACKORDER retry reports a stock condition again', async () => {
      const s = await setup();
      const { useCase, inputs } = scripted(s, [
        { kind: 'stock_unavailable' },
        { kind: 'stock_unavailable' },
      ]);
      const result = await useCase.execute(s.pending, reported('APPROVED'));
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'UnexpectedStockCondition',
      });
      expect(inputs).toHaveLength(2);
      expect(s.logger.at('alert')).toEqual([]);
    });
  });

  describe('failures', () => {
    it('propagates the repository error without a second write', async () => {
      const s = await setup();
      s.transactions.failure = { kind: 'REPOSITORY_ERROR', reason: 'ThrottlingException' };
      const result = await s.useCase.execute(s.pending, reported('DECLINED'));
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'ThrottlingException',
      });
      expect(s.transactions.appliedFinalizations).toBe(0);
    });

    it('rejects a target that is not a Final_Status without writing', async () => {
      const s = await setup();
      const result = await s.useCase.execute(s.pending, {
        source: 'provider',
        status: 'PENDING' as FinalStatus,
        report: MATCHING_REPORT,
      });
      expect(result._unsafeUnwrapErr()).toEqual({
        kind: 'REPOSITORY_ERROR',
        reason: 'InvalidTransition',
      });
      expect(s.transactions.appliedFinalizations).toBe(0);
    });
  });
});
