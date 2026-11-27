import * as fc from 'fast-check';
import { err, ok, type Result } from 'neverthrow';
import request from 'supertest';
import type { PaymentGatewayError } from '../../src/application/errors';
import type {
  ProviderStatus,
  ReconciliationOutcome,
} from '../../src/application/ports/payment-gateway';
import type { FinalStatus, TransactionStatus } from '../../src/domain/transaction-status';
import {
  postTransaction,
  referenceOfFirstAttempt,
  totalFor,
  type TransactionBody,
} from './transaction-property-helpers';
import type { TransactionsHttpApp } from './transactions-http-app';

export const RECONCILIATION_WINDOW_MS = 60_000;

/**
 * Failures of `create` after which the provider may have created the payment. The use case keeps
 * the Transaction PENDING without an External_Id and never calls `create` again.
 */
export const unreachableCreateFailureArbitrary: fc.Arbitrary<PaymentGatewayError> = fc.oneof(
  fc.constant<PaymentGatewayError>({ kind: 'UNAVAILABLE', reason: 'timeout' }),
  fc.constant<PaymentGatewayError>({ kind: 'INVALID_RESPONSE', reason: 'bad_payload' }),
  fc.constant<PaymentGatewayError>({
    kind: 'REJECTED',
    providerMessage: 'REJECTED_AFTER_RETRY',
    afterTransientFailure: true,
  }),
);

/** Failures of a lookup or a status request: the use case absorbs all of them. */
export const lookupFailureArbitrary: fc.Arbitrary<PaymentGatewayError> = fc.oneof(
  fc.constant<PaymentGatewayError>({ kind: 'UNAVAILABLE', reason: 'timeout' }),
  fc.constant<PaymentGatewayError>({ kind: 'INVALID_RESPONSE', reason: 'bad_payload' }),
  fc.constant<PaymentGatewayError>({
    kind: 'REJECTED',
    providerMessage: 'INVALID_ACCESS_TOKEN',
    afterTransientFailure: false,
  }),
);

export const finalStatusArbitrary = fc.constantFrom<FinalStatus>(
  'APPROVED',
  'DECLINED',
  'VOIDED',
  'ERROR',
);

export type LookupScenario =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'error'; readonly error: PaymentGatewayError }
  | {
      readonly kind: 'found';
      readonly externalId: string;
      readonly status: TransactionStatus;
    };

export const lookupScenarioArbitrary: fc.Arbitrary<LookupScenario> = fc.oneof(
  fc.constant<LookupScenario>({ kind: 'not_found' }),
  lookupFailureArbitrary.map((error): LookupScenario => ({ kind: 'error', error })),
  fc
    .tuple(
      fc.stringMatching(/^ext-[a-z0-9]{6,16}$/),
      fc.constantFrom<TransactionStatus>('PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR'),
    )
    .map(([externalId, status]): LookupScenario => ({ kind: 'found', externalId, status })),
);

/** What the provider reports for the first Reference of a fresh app; amounts match the stored total. */
export function matchingStatus(status: TransactionStatus, quantity: number): ProviderStatus {
  return {
    status,
    message: null,
    amountInCents: totalFor(quantity),
    currency: 'COP',
    reference: referenceOfFirstAttempt(),
  };
}

export function lookupResult(
  scenario: LookupScenario,
  quantity: number,
): Result<ReconciliationOutcome, PaymentGatewayError> {
  switch (scenario.kind) {
    case 'not_found':
      return ok({ kind: 'not_found' });
    case 'error':
      return err(scenario.error);
    case 'found':
      return ok({
        kind: 'found',
        externalId: scenario.externalId,
        status: matchingStatus(scenario.status, quantity),
      });
  }
}

/** POSTs a transaction whose `create` fails with `failure`: it stays PENDING without an External_Id. */
export async function createPendingWithoutExternalId(
  testApp: TransactionsHttpApp,
  body: TransactionBody,
  key: string,
  failure: PaymentGatewayError,
): Promise<string> {
  testApp.gateway.script.create.always(err(failure));
  const response = await postTransaction(testApp, body, key);
  if (response.status !== 201) {
    throw new Error(`test setup: expected 201 on create, got ${response.status}`);
  }
  return response.body.id as string;
}

export function getTransactionRequest(testApp: TransactionsHttpApp, id: string): request.Test {
  return request(testApp.app.getHttpServer()).get(`/api/v1/transactions/${id}`);
}
