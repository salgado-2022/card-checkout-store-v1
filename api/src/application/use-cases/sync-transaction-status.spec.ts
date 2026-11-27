import { err, errAsync, ok, okAsync } from 'neverthrow';
import type { Transaction } from '../../domain/entities';
import type { FinalStatus } from '../../domain/transaction-status';
import { FakeApplicationLogger } from '../../../test/support/fake-application-logger';
import { FakeClock } from '../../../test/support/fake-clock';
import { FakePaymentGateway } from '../../../test/support/fake-payment-gateway';
import { InMemoryDeliveryRepository } from '../../../test/support/in-memory-delivery-repository';
import { InMemoryProductRepository } from '../../../test/support/in-memory-product-repository';
import { InMemoryTransactionRepository } from '../../../test/support/in-memory-transaction-repository';
import type { PaymentGatewayError, RepositoryError } from '../errors';
import type { ProviderStatusReport } from '../ports/payment-gateway';
import { FinalizeTransaction } from './finalize-transaction';
import { SyncTransactionStatus } from './sync-transaction-status';

const TRANSACTION_ID = 'txn-1';
const REFERENCE = 'ORD-01TESTREFERENCE0000000000';
const EXTERNAL_ID = 'ext-1';
const TOTAL = 25_100_000;
const CREATED_AT = '2026-05-01T10:00:00.000Z';
const NOW = '2026-05-01T10:00:30.000Z';
const PROVIDER_TEXT = 'provider free text';
const REPO_FAILURE: RepositoryError = { kind: 'REPOSITORY_ERROR', reason: 'BoomError' };
const FINAL_STATUSES: FinalStatus[] = ['APPROVED', 'DECLINED', 'VOIDED', 'ERROR'];

const report = (
  status: FinalStatus | 'PENDING',
  overrides: { amountInCents?: number; currency?: string; reference?: string } = {},
  message: string | null = null,
): ProviderStatusReport => ({
  status,
  message,
  amountInCents: TOTAL,
  currency: 'COP',
  reference: REFERENCE,
  ...overrides,
});

const unavailable: PaymentGatewayError = { kind: 'UNAVAILABLE', reason: 'timeout' };
const rejected: PaymentGatewayError = {
  kind: 'REJECTED',
  providerMessage: PROVIDER_TEXT,
  afterTransientFailure: false,
};

interface Setup {
  readonly useCase: SyncTransactionStatus;
  readonly transactions: InMemoryTransactionRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly products: InMemoryProductRepository;
  readonly gateway: FakePaymentGateway;
  readonly logger: FakeApplicationLogger;
  readonly clock: FakeClock;
  readonly finalizeTransaction: FinalizeTransaction;
  readonly stored: Transaction;
  readonly spies: {
    readonly setExternalId: jest.SpyInstance;
    readonly setLastSynced: jest.SpyInstance;
    readonly finalize: jest.SpyInstance;
    readonly finalizeUseCase: jest.SpyInstance;
  };
}

/**
 * Builds a PENDING transaction (stock 10, quantity 2). `overrides` change what `findById`
 * returns on its first call, so tests can serve fields the repository would never store.
 */
async function setup(overrides: Partial<Transaction> = {}): Promise<Setup> {
  const products = new InMemoryProductRepository([
    {
      id: 'prod-1',
      sku: 'SKU-1',
      name: 'Product',
      description: 'Description',
      imageUrl: 'https://cdn.example/p.webp',
      priceInCents: 12_000_000,
      currency: 'COP',
      stock: 10,
    },
  ]);
  const deliveries = new InMemoryDeliveryRepository();
  const transactions = new InMemoryTransactionRepository(products, deliveries);
  const gateway = new FakePaymentGateway();
  const logger = new FakeApplicationLogger();
  const clock = new FakeClock(NOW);
  await deliveries.create({
    id: 'del-1',
    transactionId: TRANSACTION_ID,
    productId: 'prod-1',
    quantity: 2,
    recipientName: 'Ana Perez',
    phone: '3001234567',
    addressLine1: 'Calle 1 2-3',
    city: 'Bogota',
    department: 'Bogotá D.C.',
    createdAt: CREATED_AT,
  });
  const created = (
    await transactions.create({
      id: TRANSACTION_ID,
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
      createdAt: CREATED_AT,
    })
  )._unsafeUnwrap();
  const finalizeTransaction = new FinalizeTransaction(transactions, logger, clock);
  const useCase = new SyncTransactionStatus(
    transactions,
    gateway,
    finalizeTransaction,
    logger,
    clock,
  );
  const spies = {
    setExternalId: jest.spyOn(transactions, 'setExternalId'),
    setLastSynced: jest.spyOn(transactions, 'setLastSynced'),
    finalize: jest.spyOn(transactions, 'finalize'),
    finalizeUseCase: jest.spyOn(finalizeTransaction, 'execute'),
  };
  if (Object.keys(overrides).length > 0) {
    jest.spyOn(transactions, 'findById').mockReturnValueOnce(okAsync({ ...created, ...overrides }));
  }
  return {
    useCase,
    transactions,
    deliveries,
    products,
    gateway,
    logger,
    clock,
    finalizeTransaction,
    stored: created,
    spies,
  };
}

/** A PENDING transaction that already knows its External_Id, last synced a minute ago. */
const known = (): Partial<Transaction> => ({
  externalId: EXTERNAL_ID,
  lastSyncedAt: '2026-05-01T09:59:00.000Z',
});

function expectNoWrites(s: Setup): void {
  expect(s.spies.setExternalId).not.toHaveBeenCalled();
  expect(s.spies.setLastSynced).not.toHaveBeenCalled();
  expect(s.spies.finalize).not.toHaveBeenCalled();
}

/** Exactly one provider read and never a creation, whatever the branch. */
function expectOneProviderCall(s: Setup, method: 'getStatus' | 'findByReference'): void {
  expect(s.gateway.callLog).toEqual([method]);
  expect(s.gateway.callCount('create')).toBe(0);
}

function expectNoProviderTextInLogs(s: Setup): void {
  const logged = JSON.stringify(s.logger.entries);
  expect(logged).not.toContain(PROVIDER_TEXT);
  expect(logged).not.toContain('4242');
  expect(logged).not.toContain('VISA');
}

describe('SyncTransactionStatus', () => {
  describe('stored transaction', () => {
    it('returns TRANSACTION_NOT_FOUND for an unknown id without calling the gateway', async () => {
      const s = await setup();
      const result = await s.useCase.execute('missing');
      expect(result._unsafeUnwrapErr()).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      expect(s.gateway.callLog).toEqual([]);
    });

    it('returns REPOSITORY_ERROR when findById fails', async () => {
      const s = await setup();
      s.transactions.failure = REPO_FAILURE;
      const result = await s.useCase.execute(TRANSACTION_ID);
      expect(result._unsafeUnwrapErr()).toEqual(REPO_FAILURE);
      expect(s.gateway.callLog).toEqual([]);
    });

    it.each(FINAL_STATUSES)(
      'returns a stored %s transaction without gateway or finalize',
      async (status) => {
        const s = await setup({ status, externalId: EXTERNAL_ID });
        const result = await s.useCase.execute(TRANSACTION_ID);
        expect(result._unsafeUnwrap()).toMatchObject({ id: TRANSACTION_ID, status });
        expect(s.gateway.callLog).toEqual([]);
        expect(s.spies.finalizeUseCase).not.toHaveBeenCalled();
        expectNoWrites(s);
      },
    );
  });

  describe('sync interval', () => {
    it('calls getStatus with the External_Id when lastSyncedAt is missing', async () => {
      const s = await setup({ externalId: EXTERNAL_ID });
      s.gateway.script.getStatus.always(ok(report('PENDING')));
      await s.useCase.execute(TRANSACTION_ID);
      expect(s.gateway.script.getStatus.calls).toEqual([[EXTERNAL_ID]]);
      expectOneProviderCall(s, 'getStatus');
    });

    it('calls the provider when the last sync is exactly 1000 ms old', async () => {
      const s = await setup({ externalId: EXTERNAL_ID, lastSyncedAt: '2026-05-01T10:00:29.000Z' });
      s.gateway.script.getStatus.always(ok(report('PENDING')));
      await s.useCase.execute(TRANSACTION_ID);
      expectOneProviderCall(s, 'getStatus');
    });

    it('does not call the provider when the last sync is 999 ms old', async () => {
      const s = await setup({ externalId: EXTERNAL_ID, lastSyncedAt: '2026-05-01T10:00:29.001Z' });
      const result = await s.useCase.execute(TRANSACTION_ID);
      expect(result._unsafeUnwrap()).toMatchObject({ status: 'PENDING' });
      expect(s.gateway.callLog).toEqual([]);
      expectNoWrites(s);
    });

    it('calls the provider when lastSyncedAt is unreadable', async () => {
      const s = await setup({ externalId: EXTERNAL_ID, lastSyncedAt: 'not-a-date' });
      s.gateway.script.getStatus.always(ok(report('PENDING')));
      await s.useCase.execute(TRANSACTION_ID);
      expectOneProviderCall(s, 'getStatus');
    });
  });

  describe('known External_Id', () => {
    it('keeps PENDING and stores lastSyncedAt without finalizing', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(ok(report('PENDING')));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expect(s.spies.setLastSynced).toHaveBeenCalledWith(TRANSACTION_ID, new Date(NOW));
      expect(s.spies.finalizeUseCase).not.toHaveBeenCalled();
      expect(s.transactions.get(TRANSACTION_ID)?.lastSyncedAt).toBe(NOW);
      expectOneProviderCall(s, 'getStatus');
    });

    it('APPROVED: finalizes as provider with the report, assigns the delivery and decrements stock', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(ok(report('APPROVED')));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result).toMatchObject({ status: 'APPROVED', finalizedAt: NOW });
      expect(result.statusReason).toBeUndefined();
      expect(s.spies.finalizeUseCase).toHaveBeenCalledWith(
        expect.objectContaining({ id: TRANSACTION_ID }),
        {
          source: 'provider',
          status: 'APPROVED',
          report: { amountInCents: TOTAL, currency: 'COP', reference: REFERENCE },
        },
      );
      expect(s.deliveries.get('del-1')?.status).toBe('ASSIGNED');
      expect(s.products.stockOf('prod-1')).toBe(8);
      expectOneProviderCall(s, 'getStatus');
    });

    it.each<[FinalStatus, string | null, string | undefined]>([
      ['DECLINED', 'Fondos insuficientes', 'Fondos insuficientes'],
      ['VOIDED', 'Anulada por el comercio', 'Anulada por el comercio'],
      ['ERROR', 'Error del emisor', 'Error del emisor'],
      ['DECLINED', null, undefined],
    ])(
      '%s with provider message %p: stores %p, cancels the delivery, keeps stock',
      async (status, message, reason) => {
        const s = await setup(known());
        s.gateway.script.getStatus.always(ok(report(status, {}, message)));
        const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
        expect(result.status).toBe(status);
        expect(result.statusReason).toBe(reason);
        expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
        expectOneProviderCall(s, 'getStatus');
      },
    );

    it.each<[string, { amountInCents?: number; currency?: string; reference?: string }]>([
      ['amount', { amountInCents: TOTAL + 1 }],
      ['currency', { currency: 'USD' }],
      ['reference', { reference: 'ORD-OTHER' }],
    ])(
      'APPROVED with a different %s ends ERROR AMOUNT_MISMATCH with an alert',
      async (_name, diff) => {
        const s = await setup(known());
        s.gateway.script.getStatus.always(ok(report('APPROVED', diff)));
        const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
        expect(result).toMatchObject({ status: 'ERROR', statusReason: 'AMOUNT_MISMATCH' });
        expect(s.logger.at('alert')).toHaveLength(1);
        expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
      },
    );

    it('DECLINED with a different amount ends ERROR AMOUNT_MISMATCH', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(
        ok(report('DECLINED', { amountInCents: 1 }, PROVIDER_TEXT)),
      );
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result).toMatchObject({ status: 'ERROR', statusReason: 'AMOUNT_MISMATCH' });
      expect(s.logger.at('alert')).toHaveLength(1);
      expectNoProviderTextInLogs(s);
    });

    it.each<[string, PaymentGatewayError]>([
      ['UNAVAILABLE', unavailable],
      ['REJECTED', rejected],
      [
        'REJECTED 401 INVALID_ACCESS_TOKEN',
        { kind: 'REJECTED', providerMessage: 'INVALID_ACCESS_TOKEN', afterTransientFailure: false },
      ],
    ])(
      '%s keeps PENDING, warns, stores lastSyncedAt and does not finalize',
      async (_name, error) => {
        const s = await setup(known());
        s.gateway.script.getStatus.always(err(error));
        const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
        expect(result.status).toBe('PENDING');
        expect(s.spies.setLastSynced).toHaveBeenCalledWith(TRANSACTION_ID, new Date(NOW));
        expect(s.spies.finalize).not.toHaveBeenCalled();
        expect(s.logger.at('warn')).toHaveLength(1);
        expect(JSON.stringify(s.logger.entries)).not.toContain('INVALID_ACCESS_TOKEN');
        expectNoProviderTextInLogs(s);
        expectOneProviderCall(s, 'getStatus');
      },
    );

    it('logs the technical reason of a transient failure', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(err(unavailable));
      await s.useCase.execute(TRANSACTION_ID);
      expect(s.logger.at('warn')[0]?.fields).toMatchObject({
        reference: REFERENCE,
        failure: 'UNAVAILABLE',
        reason: 'timeout',
      });
    });

    it('UNKNOWN status keeps PENDING and warns', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(ok({ status: 'UNKNOWN' }));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expect(s.logger.at('warn')).toHaveLength(1);
      expect(s.spies.finalize).not.toHaveBeenCalled();
      expectOneProviderCall(s, 'getStatus');
    });

    it('a failing setLastSynced with a final status still finalizes and warns', async () => {
      const s = await setup(known());
      s.spies.setLastSynced.mockReturnValue(errAsync(REPO_FAILURE));
      s.gateway.script.getStatus.always(ok(report('APPROVED')));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('APPROVED');
      expect(s.products.stockOf('prod-1')).toBe(8);
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({
          message: 'could not store lastSyncedAt',
          fields: { reference: REFERENCE, reason: 'BoomError' },
        }),
      ]);
    });

    it('a failing setLastSynced with a provider error keeps PENDING and warns', async () => {
      const s = await setup(known());
      s.spies.setLastSynced.mockReturnValue(errAsync(REPO_FAILURE));
      s.gateway.script.getStatus.always(err(unavailable));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expect(s.logger.at('warn').map((entry) => entry.message)).toEqual([
        'could not store lastSyncedAt',
        'status request failed, transaction kept pending',
      ]);
    });

    it('returns REPOSITORY_ERROR when finalize fails', async () => {
      const s = await setup(known());
      s.spies.finalize.mockReturnValue(errAsync(REPO_FAILURE));
      s.gateway.script.getStatus.always(ok(report('APPROVED')));
      const result = await s.useCase.execute(TRANSACTION_ID);
      expect(result._unsafeUnwrapErr()).toEqual(REPO_FAILURE);
    });

    it('returns the stored final state when finalize finds the transaction already final', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(ok(report('APPROVED')));
      // A concurrent request declined it after this one read PENDING.
      await s.transactions.finalize({
        transactionId: TRANSACTION_ID,
        deliveryId: 'del-1',
        productId: 'prod-1',
        quantity: 2,
        status: 'DECLINED',
        deliveryStatus: 'CANCELLED',
        at: NOW,
      });
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('DECLINED');
      expect(s.products.stockOf('prod-1')).toBe(10);
      expect(s.transactions.appliedFinalizations).toBe(1);
    });
  });

  describe('no External_Id (reconciliation by reference)', () => {
    it('found PENDING stores the External_Id and lastSyncedAt without getStatus', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(
        ok({ kind: 'found', externalId: EXTERNAL_ID, status: report('PENDING') }),
      );
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result).toMatchObject({ status: 'PENDING', externalId: EXTERNAL_ID });
      expect(s.gateway.script.findByReference.calls).toEqual([[REFERENCE]]);
      expect(s.spies.setExternalId).toHaveBeenCalledWith(TRANSACTION_ID, EXTERNAL_ID);
      expect(s.spies.setLastSynced).toHaveBeenCalledWith(TRANSACTION_ID, new Date(NOW));
      expect(s.spies.finalize).not.toHaveBeenCalled();
      expectOneProviderCall(s, 'findByReference');
    });

    it('found APPROVED stores the External_Id and finalizes with the report', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(
        ok({ kind: 'found', externalId: EXTERNAL_ID, status: report('APPROVED') }),
      );
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('APPROVED');
      expect(s.transactions.get(TRANSACTION_ID)?.externalId).toBe(EXTERNAL_ID);
      expect(s.spies.finalizeUseCase).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: EXTERNAL_ID }),
        {
          source: 'provider',
          status: 'APPROVED',
          report: { amountInCents: TOTAL, currency: 'COP', reference: REFERENCE },
        },
      );
      expect(s.products.stockOf('prod-1')).toBe(8);
      expectOneProviderCall(s, 'findByReference');
    });

    it('found with a mismatching amount ends ERROR AMOUNT_MISMATCH', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(
        ok({
          kind: 'found',
          externalId: EXTERNAL_ID,
          status: report('APPROVED', { amountInCents: 1 }),
        }),
      );
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result).toMatchObject({ status: 'ERROR', statusReason: 'AMOUNT_MISMATCH' });
      expect(s.logger.at('alert')).toHaveLength(1);
    });

    it('found UNKNOWN stores the External_Id, keeps PENDING and warns', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(
        ok({ kind: 'found', externalId: EXTERNAL_ID, status: { status: 'UNKNOWN' } }),
      );
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expect(s.transactions.get(TRANSACTION_ID)?.externalId).toBe(EXTERNAL_ID);
      expect(s.logger.at('warn')).toHaveLength(1);
      expect(s.spies.finalize).not.toHaveBeenCalled();
    });

    it('returns REPOSITORY_ERROR without finalizing when setExternalId fails', async () => {
      const s = await setup();
      s.spies.setExternalId.mockReturnValue(errAsync(REPO_FAILURE));
      s.gateway.script.findByReference.always(
        ok({ kind: 'found', externalId: EXTERNAL_ID, status: report('APPROVED') }),
      );
      const result = await s.useCase.execute(TRANSACTION_ID);
      expect(result._unsafeUnwrapErr()).toEqual(REPO_FAILURE);
      expect(s.spies.setLastSynced).not.toHaveBeenCalled();
      expect(s.spies.finalize).not.toHaveBeenCalled();
    });

    it('an immediate second GET after found PENDING does not call the provider', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(
        ok({ kind: 'found', externalId: EXTERNAL_ID, status: report('PENDING') }),
      );
      await s.useCase.execute(TRANSACTION_ID);
      const second = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(second.status).toBe('PENDING');
      expect(s.gateway.callLog).toEqual(['findByReference']);
    });

    it.each([60_000, 60_001])(
      'not_found at %i ms ends ERROR PROVIDER_UNREACHABLE without Amount_Check',
      async (age) => {
        const s = await setup();
        s.clock.set(new Date(Date.parse(CREATED_AT) + age));
        s.gateway.script.findByReference.always(ok({ kind: 'not_found' }));
        const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
        expect(result).toMatchObject({ status: 'ERROR', statusReason: 'PROVIDER_UNREACHABLE' });
        expect(s.spies.finalizeUseCase).toHaveBeenCalledWith(expect.anything(), {
          source: 'internal',
          status: 'ERROR',
          statusReason: 'PROVIDER_UNREACHABLE',
        });
        expect(s.logger.at('alert')).toEqual([]);
        expect(s.deliveries.get('del-1')?.status).toBe('CANCELLED');
        expect(s.products.stockOf('prod-1')).toBe(10);
        expect(s.spies.setExternalId).not.toHaveBeenCalled();
        expect(s.spies.setLastSynced).not.toHaveBeenCalled();
        expectOneProviderCall(s, 'findByReference');
      },
    );

    it('not_found at 59999 ms keeps PENDING with no writes', async () => {
      const s = await setup();
      s.clock.set(new Date(Date.parse(CREATED_AT) + 59_999));
      s.gateway.script.findByReference.always(ok({ kind: 'not_found' }));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expectNoWrites(s);
      expectOneProviderCall(s, 'findByReference');
    });

    it.each([30_000, 120_000])(
      'a lookup error at %i ms keeps PENDING, warns and writes nothing',
      async (age) => {
        const s = await setup();
        s.clock.set(new Date(Date.parse(CREATED_AT) + age));
        s.gateway.script.findByReference.always(err(unavailable));
        const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
        expect(result.status).toBe('PENDING');
        expect(s.logger.at('warn')).toHaveLength(1);
        expect(s.logger.at('warn')[0]?.message).toBe(
          'reference lookup failed, transaction kept pending',
        );
        expectNoWrites(s);
        expectOneProviderCall(s, 'findByReference');
      },
    );

    it('a rejected lookup hides the provider message from the logs', async () => {
      const s = await setup();
      s.gateway.script.findByReference.always(err(rejected));
      await s.useCase.execute(TRANSACTION_ID);
      expect(s.logger.at('warn')[0]?.fields).toEqual({ reference: REFERENCE, failure: 'REJECTED' });
      expectNoProviderTextInLogs(s);
    });

    it('not_found with an unreadable createdAt keeps PENDING and warns', async () => {
      const s = await setup({ createdAt: 'garbage' });
      s.clock.set(new Date(Date.parse(CREATED_AT) + 600_000));
      s.gateway.script.findByReference.always(ok({ kind: 'not_found' }));
      const result = (await s.useCase.execute(TRANSACTION_ID))._unsafeUnwrap();
      expect(result.status).toBe('PENDING');
      expect(s.logger.at('warn')).toEqual([
        expect.objectContaining({
          message: 'unreadable createdAt',
          fields: { reference: REFERENCE },
        }),
      ]);
      expectNoWrites(s);
    });
  });

  describe('provider calls per invocation', () => {
    it('is exactly one getStatus and no create for a pending report', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(ok(report('PENDING')));
      await s.useCase.execute(TRANSACTION_ID);
      expectOneProviderCall(s, 'getStatus');
    });

    it.each([
      ['not_found', ok({ kind: 'not_found' as const })],
      ['lookup error', err(unavailable)],
      [
        'found',
        ok({ kind: 'found' as const, externalId: EXTERNAL_ID, status: report('APPROVED') }),
      ],
    ])('is exactly one findByReference and no create (%s)', async (_name, response) => {
      const s = await setup();
      s.gateway.script.findByReference.always(response);
      await s.useCase.execute(TRANSACTION_ID);
      expectOneProviderCall(s, 'findByReference');
    });

    it('is exactly one getStatus and no create after a getStatus error', async () => {
      const s = await setup(known());
      s.gateway.script.getStatus.always(err(unavailable));
      await s.useCase.execute(TRANSACTION_ID);
      expectOneProviderCall(s, 'getStatus');
    });
  });
});
