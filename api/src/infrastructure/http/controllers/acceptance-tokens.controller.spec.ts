import type { INestApplication } from '@nestjs/common';
import { err, ok } from 'neverthrow';
import request from 'supertest';
import type { PaymentGatewayError } from '../../../application/errors';
import type { AcceptanceTokens } from '../../../application/ports/payment-gateway';
import { FakePaymentGateway } from '../../../../test/support/fake-payment-gateway';
import { createAcceptanceTokensHttpApp } from '../../../../test/support/acceptance-tokens-http-app';

const TOKENS: AcceptanceTokens = {
  acceptanceToken: { token: 'tok_test_fake_acceptance', permalink: 'https://payment.test/docs/a' },
  acceptPersonalAuth: { token: 'tok_test_fake_personal', permalink: 'https://payment.test/docs/p' },
};

const PROVIDER_ERROR_BODY = {
  statusCode: 502,
  code: 'PAYMENT_PROVIDER_ERROR',
  message: 'The payment provider could not process the request.',
  details: [],
};

describe('AcceptanceTokensController (HTTP)', () => {
  let app: INestApplication;
  let gateway: FakePaymentGateway;

  beforeEach(async () => {
    gateway = new FakePaymentGateway();
    app = await createAcceptanceTokensHttpApp({ gateway });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/acceptance-tokens', () => {
    it('returns 200 with exactly the token and permalink of both documents', async () => {
      gateway.script.getAcceptanceTokens.enqueue(ok(TOKENS));

      const response = await request(app.getHttpServer()).get('/api/v1/acceptance-tokens');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        acceptanceToken: {
          token: 'tok_test_fake_acceptance',
          permalink: 'https://payment.test/docs/a',
        },
        acceptPersonalAuth: {
          token: 'tok_test_fake_personal',
          permalink: 'https://payment.test/docs/p',
        },
      });
    });

    it('drops any field the gateway returns beyond the two documents', async () => {
      const withExtras = {
        ...TOKENS,
        acceptanceToken: { ...TOKENS.acceptanceToken, extra: 'not for clients' },
        providerSecret: 'not for clients',
      } as AcceptanceTokens;
      gateway.script.getAcceptanceTokens.enqueue(ok(withExtras));

      const response = await request(app.getHttpServer()).get('/api/v1/acceptance-tokens');

      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(['acceptPersonalAuth', 'acceptanceToken']);
      expect(Object.keys(response.body.acceptanceToken).sort()).toEqual(['permalink', 'token']);
      expect(JSON.stringify(response.body)).not.toContain('not for clients');
    });

    it.each<[string, PaymentGatewayError]>([
      [
        'a 4xx rejection',
        { kind: 'REJECTED', providerMessage: 'HTTP 401', afterTransientFailure: false },
      ],
      ['an unavailable provider', { kind: 'UNAVAILABLE', reason: 'AbortError' }],
      ['an unreadable response', { kind: 'INVALID_RESPONSE', reason: 'SchemaMismatch' }],
    ])(
      'returns 502 PAYMENT_PROVIDER_ERROR with the fixed message for %s',
      async (_label, failure) => {
        gateway.script.getAcceptanceTokens.enqueue(err(failure));

        const response = await request(app.getHttpServer()).get('/api/v1/acceptance-tokens');

        expect(response.status).toBe(502);
        expect(response.body).toEqual(PROVIDER_ERROR_BODY);
        expect(JSON.stringify(response.body)).not.toMatch(
          /AbortError|SchemaMismatch|HTTP 401|providerMessage/,
        );
      },
    );
  });
});
