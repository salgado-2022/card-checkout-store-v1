import { err, ok } from 'neverthrow';
import type { PaymentGatewayError } from '../errors';
import type { AcceptanceTokens } from '../ports/payment-gateway';
import { FakePaymentGateway } from '../../../test/support/fake-payment-gateway';
import { FakeApplicationLogger } from '../../../test/support/fake-application-logger';
import { GetAcceptanceTokens } from './get-acceptance-tokens';

const TOKENS: AcceptanceTokens = {
  acceptanceToken: { token: 'tok_test_fake_acceptance', permalink: 'https://payment.test/docs/a' },
  acceptPersonalAuth: { token: 'tok_test_fake_personal', permalink: 'https://payment.test/docs/p' },
};

describe('GetAcceptanceTokens', () => {
  let gateway: FakePaymentGateway;
  let logger: FakeApplicationLogger;
  let useCase: GetAcceptanceTokens;

  beforeEach(() => {
    gateway = new FakePaymentGateway();
    logger = new FakeApplicationLogger();
    useCase = new GetAcceptanceTokens(gateway, logger);
  });

  it('returns the tokens from the gateway without logging anything', async () => {
    gateway.script.getAcceptanceTokens.enqueue(ok(TOKENS));

    const result = await useCase.execute();

    expect(result._unsafeUnwrap()).toEqual(TOKENS);
    expect(logger.entries).toEqual([]);
    expect(gateway.callLog).toEqual(['getAcceptanceTokens']);
  });

  it.each<[string, PaymentGatewayError, Record<string, unknown>]>([
    [
      'a 4xx rejection',
      { kind: 'REJECTED', providerMessage: 'HTTP 401', afterTransientFailure: false },
      { kind: 'REJECTED', afterTransientFailure: false },
    ],
    [
      'a 4xx after a transient failure',
      { kind: 'REJECTED', providerMessage: 'HTTP 404', afterTransientFailure: true },
      { kind: 'REJECTED', afterTransientFailure: true },
    ],
    [
      'an unavailable provider',
      { kind: 'UNAVAILABLE', reason: '503' },
      { kind: 'UNAVAILABLE', reason: '503' },
    ],
    [
      'an unreadable response',
      { kind: 'INVALID_RESPONSE', reason: 'SchemaMismatch' },
      { kind: 'INVALID_RESPONSE', reason: 'SchemaMismatch' },
    ],
  ])('maps %s to PAYMENT_PROVIDER_ERROR and logs a warning', async (_label, failure, fields) => {
    gateway.script.getAcceptanceTokens.enqueue(err(failure));

    const result = await useCase.execute();

    expect(result._unsafeUnwrapErr()).toEqual({ kind: 'PAYMENT_PROVIDER_ERROR' });
    expect(logger.at('warn')).toEqual([
      { level: 'warn', message: 'acceptance tokens unavailable', fields },
    ]);
  });

  it('does not put the provider message in the error or in the log', async () => {
    gateway.script.getAcceptanceTokens.enqueue(
      err({
        kind: 'REJECTED',
        providerMessage: 'SECRET_PROVIDER_TEXT',
        afterTransientFailure: false,
      }),
    );

    const result = await useCase.execute();

    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain('SECRET_PROVIDER_TEXT');
    expect(JSON.stringify(logger.entries)).not.toContain('SECRET_PROVIDER_TEXT');
  });
});
